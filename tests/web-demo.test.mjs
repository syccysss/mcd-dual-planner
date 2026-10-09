import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWebDemo } from '../tools/build-web-demo.mjs';

/**
 * 网页 demo 生成器的最小回归：
 * 它把 src/ 的求解器内联进单文件 HTML，一旦 import/export 剥离逻辑写坏，
 * 页面在浏览器里会直接白屏 —— 这种失败方式只有打开页面才发现，所以放进自动化测试里拦。
 */
test('网页 demo 生成器：产出自包含 HTML，内联求解器与数据集且无残留 import', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcd-web-'));
  const out = join(dir, 'index.html');
  try {
    await buildWebDemo({ out });
    const html = readFileSync(out, 'utf8');
    assert.ok(html.includes('const Normalize = (function'), '应内联 Normalize 命名空间');
    assert.ok(html.includes('const Solver = (function'), '应内联 Solver 命名空间');
    assert.ok(html.includes('const DATA ='), '应内联数据集');
    assert.ok(html.includes('solve({'), '应调用求解器');
    const script = html.split('<script>')[1] ?? '';
    assert.ok(script.length > 10000, '内联脚本不应为空白');
    assert.ok(!/^\s*import\s/m.test(script), '内联脚本里不应残留 ESM import');
    assert.ok(!/^\s*export\s/m.test(script), '内联脚本里不应残留 ESM export');
    assert.ok(html.length > 20000, '产物应有实际体积（非空壳）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
