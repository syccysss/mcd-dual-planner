/**
 * 相对链接检查器
 * ---------------------------------------------------------------
 * 扫描仓库内所有 Markdown 文件里的相对链接与图片引用，确认目标文件真实存在。
 * README 里一个断链就足以让评审怀疑项目的完成度，所以放进 CI 里自动拦。
 *
 * 用法: node tools/check-links.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', '.reference', 'reports', 'out', 'dist']);

async function collectMarkdown(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectMarkdown(full)));
    else if (/\.md$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** 抽出 [文字](目标) 与 <目标> 形式的引用 */
function extractLinks(text) {
  const links = [];
  const mdLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = mdLink.exec(text)) !== null) links.push(match[1]);
  const angle = /<((?:\.{1,2}\/)[^>\s]+)>/g;
  while ((match = angle.exec(text)) !== null) links.push(match[1]);
  return links;
}

const files = await collectMarkdown(ROOT);
const problems = [];
let checked = 0;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const rawTarget of extractLinks(text)) {
    const target = rawTarget.split('#')[0];
    if (!target) continue; // 纯锚点
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http(s): / mailto: 等
    checked += 1;
    const abs = resolve(dirname(file), decodeURIComponent(target));
    try {
      await stat(abs);
    } catch {
      problems.push(`${relative(ROOT, file)} → ${rawTarget}`);
    }
  }
}

console.log(`扫描 Markdown 文件 ${files.length} 个，检查相对链接 ${checked} 条`);
if (problems.length) {
  console.log(`\n发现 ${problems.length} 条断链:`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('OK: 所有相对链接均可解析');
