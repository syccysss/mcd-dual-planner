import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { McpClient, McpError } from '../src/mcp-client.mjs';
import { ToolRegistry, READ_ONLY_TOOLS, WRITE_TOOLS, buildArgs, mapParams } from '../src/tools.mjs';

const FAKE_TOKEN = 'fake-token-abcdefghijklmnop0123456789';

/** 构造一个假的 fetch，用来在离线环境里验证客户端的错误处理与脱敏 */
function fakeFetch(response) {
  return async () => response;
}

test('缺少 Token 时立刻失败，并给出可操作提示', () => {
  assert.throws(() => new McpClient({}), (err) => {
    assert.ok(err instanceof McpError);
    assert.equal(err.kind, 'config');
    assert.ok(err.hint.includes('MCD_MCP_TOKEN'));
    return true;
  });
});

test('describe() 与 JSON.stringify 都不会泄露 Token', () => {
  const client = new McpClient({ token: FAKE_TOKEN });
  const described = JSON.stringify(client.describe());
  const serialized = JSON.stringify(client);
  assert.ok(!described.includes(FAKE_TOKEN));
  assert.ok(!serialized.includes(FAKE_TOKEN));
  assert.equal(client.describe().hasToken, true);
});

test('401 错误信息里不会出现 Token', async () => {
  const client = new McpClient({
    token: FAKE_TOKEN,
    fetchImpl: fakeFetch(new Response(JSON.stringify({ error: 'unauthorized', token: FAKE_TOKEN }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })),
  });
  await assert.rejects(() => client.listTools(), (err) => {
    assert.equal(err.kind, 'auth');
    assert.ok(!err.message.includes(FAKE_TOKEN));
    assert.ok(!String(err.hint).includes(FAKE_TOKEN));
    return true;
  });
});

test('上游把 Token 回显在错误体里时，也会被脱敏', async () => {
  const client = new McpClient({
    token: FAKE_TOKEN,
    fetchImpl: fakeFetch(new Response(`internal error, got Bearer ${FAKE_TOKEN}`, { status: 500 })),
  });
  await assert.rejects(() => client.listTools(), (err) => {
    assert.ok(!err.message.includes(FAKE_TOKEN));
    assert.ok(!String(err.hint).includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(FAKE_TOKEN));
    return true;
  });
});

test('429 被识别为限流，并提示不要循环重试', async () => {
  const client = new McpClient({
    token: FAKE_TOKEN,
    fetchImpl: fakeFetch(new Response('too many requests', { status: 429 })),
  });
  await assert.rejects(() => client.listTools(), (err) => {
    assert.equal(err.kind, 'rate_limit');
    assert.ok(err.hint.includes('限流') || err.hint.includes('重试'));
    return true;
  });
});

test('写操作工具被硬性拒绝：本项目绝不下单', async () => {
  const client = new McpClient({ token: FAKE_TOKEN });
  const registry = new ToolRegistry(client);
  // 直接注入工具清单，避免真的发请求
  registry.constructor.prototype.load = async () => new Map();
  const map = new Map([['create-order', { name: 'create-order', inputSchema: { properties: {} } }]]);
  registry.load = async () => map;
  await registry.load();

  for (const name of WRITE_TOOLS) {
    await assert.rejects(() => registry.call(name), /写操作工具/, `${name} 必须被拒绝`);
  }
});

test('不在只读白名单里的工具也会被拒绝', async () => {
  const client = new McpClient({ token: FAKE_TOKEN });
  const registry = new ToolRegistry(client);
  registry.load = async () => new Map([['some-unknown-tool', { name: 'some-unknown-tool', inputSchema: { properties: {} } }]]);
  await registry.load();
  await assert.rejects(() => registry.call('some-unknown-tool'), /只读白名单/);
});

test('只读白名单里不包含任何写操作', () => {
  for (const name of WRITE_TOOLS) {
    assert.ok(!READ_ONLY_TOOLS.has(name), `${name} 不应出现在只读白名单中`);
  }
});

test('参数自适应：schema 改名后仍能映射到正确参数名', () => {
  const tool = { name: 'query-meals', inputSchema: { properties: { be_code: { type: 'string' }, beType: { type: 'integer' } } } };
  const { args, unmatched } = buildArgs(tool, { beCode: 'S1', beType: 1 });
  assert.equal(args.be_code, 'S1');
  assert.equal(args.beType, 1);
  assert.deepEqual(unmatched, []);
});

test('参数分组映射：候选名按顺序命中，全部落空时如实上报', () => {
  const tool = { name: 'query-nearby-stores', inputSchema: { properties: { city: { type: 'string' } } } };
  const hit = mapParams(tool, [{ keys: ['cityName', 'city'], value: '成都' }]);
  assert.deepEqual(hit.args, { city: '成都' });
  assert.deepEqual(hit.unmatched, []);

  const miss = mapParams(tool, [{ keys: ['unknownParam'], value: 'x' }]);
  assert.deepEqual(miss.args, {});
  assert.deepEqual(miss.unmatched, ['unknownParam']);
});

test('仓库内不得出现真实 Token 或凭据（提交前硬性检查）', async () => {
  const root = process.cwd();
  const skipDirs = new Set(['.git', 'node_modules', '.reference', 'reports', 'dist', 'coverage']);
  const files = [];

  async function walk(dir, depth = 0) {
    if (depth > 8) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (skipDirs.has(entry.name)) continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (/\.(mjs|js|json|md|txt|yml|yaml|example)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  await walk(root);
  assert.ok(files.length > 10, '应当扫描到仓库文件');

  // 真实的 MCP Token 形态：Bearer 后跟一长串字符；占位符与环境变量引用不算
  const suspicious = /Bearer\s+(?!\$\{|YOUR_MCP_TOKEN|<|\[redacted\]|"|\s*$)[A-Za-z0-9._~+/=-]{20,}/;
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (suspicious.test(text)) offenders.push(relative(root, file));
  }
  assert.deepEqual(offenders, [], `以下文件疑似包含真实 Token：${offenders.join(', ')}`);
});
