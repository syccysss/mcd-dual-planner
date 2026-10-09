// 抓取官方原文文件（逐字节保存，不修改内容）
// 用法: node tools/fetch-official.mjs
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();

const TARGETS = [
  {
    url: 'https://raw.githubusercontent.com/M-China/mcd-developer-innovation-challenge/main/CONTEST_DECLARATION.md',
    out: 'CONTEST_DECLARATION.md',
    note: '官方参赛声明原文（禁止改动）',
  },
  {
    url: 'https://raw.githubusercontent.com/M-China/mcd-developer-innovation-challenge/main/RANKING.md',
    out: '.reference/RANKING.md',
    note: '官方排行榜',
  },
  {
    url: 'https://raw.githubusercontent.com/M-China/mcd-mcp-server/main/README.md',
    out: '.reference/mcd-mcp-server-README.md',
    note: '麦当劳 MCP Server 使用指南',
  },
  {
    url: 'https://raw.githubusercontent.com/M-China/mcd-mcp-server/main/README_EN.md',
    out: '.reference/mcd-mcp-server-README_EN.md',
    note: '麦当劳 MCP Server 使用指南（英文）',
  },
];

const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, attempts = 5) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'mcd-dual-planner/0.1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (i < attempts) await sleep(600 * i);
    }
  }
  throw lastError;
}

for (const t of TARGETS) {
  const abs = join(ROOT, t.out);
  try {
    const buf = await fetchWithRetry(t.url);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    results.push({ ok: true, out: t.out, bytes: buf.length, sha, note: t.note });
  } catch (err) {
    results.push({ ok: false, out: t.out, error: String(err?.message ?? err), note: t.note });
  }
}

for (const r of results) {
  if (r.ok) console.log(`OK    ${r.out.padEnd(34)} ${String(r.bytes).padStart(7)} bytes  sha256=${r.sha}  ${r.note}`);
  else console.log(`FAIL  ${r.out.padEnd(34)} ${r.error}  ${r.note}`);
}

console.log(results.every((r) => r.ok) ? '\nALL FETCHED' : '\nSOME FAILED');
