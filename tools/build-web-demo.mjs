/**
 * 单文件网页 demo 生成器
 * ---------------------------------------------------------------
 * 产出一个**零依赖、可离线双击打开**的 HTML：把数据集与求解器代码全部内联，
 * 打开就能调预算/营养目标、实时看三个结论，不需要服务器、不联网。
 *
 * 为什么内联而不是 npm 打包：
 *  1. 参赛项目的评分者很可能只是点开链接看一眼，`npm install` 这一步就会劝退一半人；
 *  2. 内联的是 `src/normalize.mjs` / `src/solver.mjs` 的**同一份代码**（生成时按
 *     import/export 剥离后包成 IIFE），不是另写一份"网页版算法"，避免口径漂移。
 *
 * 用法：
 *   node tools/build-web-demo.mjs                        # 用内置演示数据
 *   node tools/build-web-demo.mjs --data snapshot.json   # 用真实门店快照
 *   node tools/build-web-demo.mjs --out web/index.html --title "麦麦双赢"
 *
 * 真实快照怎么来：
 *   node bin/mcd-dual.mjs plan --budget 40 --city 成都 --store 春熙路 --dump-data snapshot.json
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) out[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

/** 把 ESM 模块剥成可内联的 IIFE，并返回导出名清单 */
function toNamespace(source, ns) {
  const exported = [];
  const re = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
  let m;
  while ((m = re.exec(source)) !== null) exported.push(m[1]);
  const body = source
    .replace(/^\s*import[^;]*;\s*$/gm, '') // 这两个模块本身无 import，双保险
    .replace(/^export\s+/gm, '');
  return {
    code: `const ${ns} = (function(){\n${body}\nreturn { ${exported.join(', ')} };\n})();`,
    exported,
  };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 读取数据集：真实快照 or 内置演示数据 */
async function loadDataset(dataPath) {
  if (dataPath) {
    const data = JSON.parse(await readFile(resolve(String(dataPath)), 'utf8'));
    data.mode = data.mode || 'live';
    return { data, from: `真实快照 ${resolve(String(dataPath))}` };
  }
  const { demoDataset } = await import(pathToFileURL(resolve(ROOT, 'src/demo-data.mjs')).href);
  const ds = demoDataset();
  return {
    data: {
      mode: 'demo',
      store: ds.store,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      budgetFen: 3000,
      targets: { kcal: 700, proteinG: 30, sodiumMaxMg: 1200, kcalTolerance: 0.2 },
      menu: ds.menu,
      nutrition: ds.nutrition,
      coupons: ds.coupons.map((c) => ({ ...c, usable: true, excludedReason: null })),
      dataNotes: ds.warnings,
    },
    from: '内置演示数据（合成数据，非官方）',
  };
}

/**
 * 生成单文件 HTML。
 * @returns {Promise<{outPath:string, bytes:number, data:object, exported:object}>}
 */
export async function buildWebDemo({ title, out, data: dataInput } = {}) {
  const outPath = resolve(String(out ?? 'web/index.html'));
  const { data, from } = dataInput
    ? { data: dataInput, from: '调用方直接传入的数据集' }
    : await loadDataset(undefined);
  const pageTitle = String(title ?? (data.mode === 'live'
    ? '麦麦双赢 · 配餐工作台（真实门店快照）'
    : '麦麦双赢 · 配餐工作台（合成演示数据）'));

  if (!Array.isArray(data.menu) || !data.menu.length) throw new Error('数据集缺少 menu，无法生成网页。');
  if (!Array.isArray(data.nutrition) || !data.nutrition.length) throw new Error('数据集缺少 nutrition，无法生成网页。');

  const normalize = toNamespace(await readFile(resolve('src/normalize.mjs'), 'utf8'), 'Normalize');
  const solver = toNamespace(await readFile(resolve('src/solver.mjs'), 'utf8'), 'Solver');
  const template = await readFile(resolve('tools/web-demo-template.html'), 'utf8');

  const footer = data.mode === 'live'
    ? `真实门店快照于 ${esc(data.generatedAt)} 抓取自麦当劳中国 MCP，价格为当时官方算价结果；实际供应与价格以官方渠道为准。`
    : '本页使用内置合成演示数据，仅用于演示算法与交互，不代表任何真实门店。';

  const html = template
    .replace('__TITLE__', esc(pageTitle))
    .replace('__FOOTER__', footer)
    .replace('/*__DATA__*/', JSON.stringify(data, null, 2))
    .replace('/*__BUNDLES__*/', `${normalize.code}\n${solver.code}`);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf8');

  return {
    outPath,
    bytes: Buffer.byteLength(html, 'utf8'),
    from,
    data,
    exported: { Normalize: normalize.exported.length, Solver: solver.exported.length },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { data, from } = await loadDataset(options.data);
  const result = await buildWebDemo({
    title: options.title,
    out: options.out ?? 'web/index.html',
    data,
  });
  console.log(`数据来源：${from}`);
  console.log(`已生成：${result.outPath}（${(result.bytes / 1024).toFixed(0)} KB，零依赖，双击即可离线打开）`);
  console.log(`内联导出：Normalize[${result.exported.Normalize}] Solver[${result.exported.Solver}]，`
    + `数据：菜单 ${result.data.menu.length} 项 / 营养 ${result.data.nutrition.length} 条 / 券 ${(result.data.coupons || []).length} 张`);
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('生成失败：', err.message);
    process.exitCode = 1;
  });
}
