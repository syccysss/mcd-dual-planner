#!/usr/bin/env node
/**
 * 麦麦双赢 · 命令行入口
 * ---------------------------------------------------------------
 *   mcd-dual doctor            自检：Token、协议、工具清单、只读白名单覆盖度
 *   mcd-dual plan --demo       离线演示：用合成数据跑通求解与出图（无需 Token）
 *   mcd-dual plan --budget 30  实时模式：调用官方 MCP 取真实数据并出图
 *
 * 设计原则：实时模式失败就明确报错，绝不静默降级成演示数据 —— 因为"看起来像真数据
 * 的假数据"是这类工具最危险的失败方式。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { McpClient, McpError, DEFAULT_ENDPOINT } from '../src/mcp-client.mjs';
import { ToolRegistry, READ_ONLY_TOOLS, summarizeCalls } from '../src/tools.mjs';
import { buildPlanDemo, buildPlanLive } from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { formatYuan } from '../src/normalize.mjs';

const HELP = `麦麦双赢（M-Dual Planner）— 省钱 × 营养 双目标配餐引擎

用法：
  mcd-dual doctor [选项]                 环境与能力自检（建议第一次先跑这个）
  mcd-dual plan [选项]                   求解并生成 SVG 战报

通用选项：
  --demo                     强制使用离线演示数据（合成数据，无需 Token）
  --json <path>              额外输出完整求解结果 JSON
  --quiet                    只输出结果文件路径

plan 选项：
  --budget <元>              每餐预算上限，默认 30
  --kcal <数值>              热量目标，默认 700
  --protein <克>             蛋白质下限，默认 30
  --sodium <毫克>            钠上限，默认 1200
  --tolerance <比例>         热量容差，默认 0.2（即 ±20%）
  --min-score <分值>         "营养合格"门槛，默认 70
  --per-category <数量>      每品类参与枚举的候选数，默认 8（调大更接近穷举）
  --out <path>               战报输出路径，默认 reports/report.svg
  --no-verify                跳过官方算价核验（减少请求量）

实时模式取数选项：
  --city <城市>              城市，如 成都
  --store <关键词>           门店名或地标关键词
  --store-code <门店编码>    直接指定门店编码
  --be-type <数字>           取餐方式，1=到店自取（默认），5=得来速
  --search-type <数字>       1=收藏餐厅，2=按城市+关键词搜索（默认）
  --combo-limit <数量>       最多拆解多少个套餐的营养，默认 12
  --endpoint <URL>           MCP 端点，默认 https://mcp.mcd.cn
  --min-interval-ms <毫秒>   请求最小间隔，默认 120（官方限流 600/分钟）
  --timeout-ms <毫秒>        单请求超时，默认 30000

doctor 选项：
  --dump-schema <path>       把 tools/list 的原始 schema 写到文件，便于核对参数名

环境变量：
  MCD_MCP_TOKEN              麦当劳 MCP Token（在 https://open.mcd.cn/mcp 申请）
                             只从环境变量读取，不会写入任何文件或日志。
`;

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

function line(char = '─', width = 68) {
  return char.repeat(width);
}

function fmtItemList(items) {
  return items.map((i) => `${i.name}（${formatYuan(i.priceFen, { withSymbol: true })}）`).join(' + ');
}

function printPlanSummary(result, { outPath, jsonPath }) {
  const mode = result.meta.mode === 'live' ? '实时数据（官方 MCP）' : '演示数据（离线合成，非官方结果）';
  const out = [];
  out.push('');
  out.push(line('═'));
  out.push('  麦麦双赢 · 配餐战报');
  out.push(line('═'));
  out.push(`  数据模式   ${mode}`);
  out.push(`  门店       ${result.meta.store?.name ?? '—'}${result.meta.store?.code ? `（${result.meta.store.code}）` : ''}`);
  out.push(`  生成时间   ${result.meta.generatedAt}`);
  out.push(`  预算       ¥${formatYuan(result.budgetFen)}`);
  out.push(`  营养目标   ${result.targets.kcal} kcal（±${Math.round((result.targets.kcalTolerance ?? 0.2) * 100)}%）`
    + ` · 蛋白 ≥ ${result.targets.proteinG} g · 钠 ≤ ${result.targets.sodiumMaxMg} mg`);
  out.push(line());

  const labels = ['双赢推荐（达标里最便宜）', '营养上限（预算内最高分）', '省钱底线（绝对最便宜）'];
  result.recommendations.forEach((plan, index) => {
    const t = plan.totals;
    out.push('');
    out.push(`  【${labels[index] ?? `方案 ${index + 1}`}】`);
    out.push(`    ${fmtItemList(plan.items)}`);
    out.push(`    本地菜单价合计 ¥${formatYuan(t.priceFen)}　|　${t.energyKcal} kcal　|　蛋白 ${t.proteinG} g`
      + `　|　脂肪 ${t.fatG} g　|　钠 ${t.sodiumMg} mg`);
    const checks = Object.entries(plan.checks).map(([k, v]) => `${v ? '✓' : '✗'}${k}`).join(' ');
    out.push(`    营养得分 ${plan.score}/100　达标：${checks}`);
  });

  if (result.priceVerification) {
    out.push('');
    out.push(line());
    out.push('  官方算价核验');
    for (const row of result.priceVerification.verified) {
      const delta = row.localFen !== null && row.officialFen !== null ? row.officialFen - row.localFen : null;
      const deltaText = delta === null ? '无法比较' : delta === 0 ? '一致' : `${delta > 0 ? '+' : ''}${formatYuan(delta)} 元`;
      const coupon = row.couponName ? `　券：${row.couponName}` : '';
      out.push(`    ${row.label}：本地 ¥${formatYuan(row.localFen)} → 官方 ¥${formatYuan(row.officialFen)}（${deltaText}）${coupon}`);
    }
    for (const row of result.priceVerification.failures) {
      out.push(`    ${row.label}：验价失败 —— ${row.reason}`);
    }
  }

  out.push('');
  out.push(line());
  const s = result.stats;
  out.push(`  搜索空间  菜单 ${result.coverage.menuTotal} 项 → 候选 ${s.candidateCount} 项`
    + ` → 枚举 ${s.totalPlans} 个方案 → 预算内 ${s.withinBudget} 个 → 达标 ${s.qualifying} 个`);
  const nutritionSource = result.meta.mode === 'live' ? '官方营养数据' : '演示营养数据';
  out.push(`  营养覆盖  ${result.coverage.matched}/${result.coverage.menuTotal} 项匹配到${nutritionSource}`
    + `（未匹配 ${result.coverage.unmatched} 项已排除，不使用猜测值）`);
  out.push(`  帕累托前沿 ${result.pareto.length} 个非支配解`);

  if (result.dataNotes?.length) {
    out.push('');
    out.push('  数据口径与提示');
    for (const note of result.dataNotes) out.push(`    · ${note}`);
  }

  out.push('');
  out.push(line());
  out.push(`  战报已生成  ${outPath}`);
  if (jsonPath) out.push(`  结果 JSON   ${jsonPath}`);
  out.push('');
  out.push('  提示：本项目为参赛作品，非麦当劳官方产品；价格与供应以官方渠道实时结果为准。');
  out.push(line('═'));
  out.push('');
  return out.join('\n');
}

async function cmdDoctor(options) {
  const token = process.env.MCD_MCP_TOKEN;
  const out = [];
  out.push('');
  out.push(line('═'));
  out.push('  麦麦双赢 · 环境自检');
  out.push(line('═'));
  out.push(`  Node 版本   ${process.version}`);
  out.push(`  MCP 端点    ${options.endpoint ?? DEFAULT_ENDPOINT}`);
  out.push(`  Token       ${token ? '已从环境变量 MCD_MCP_TOKEN 读取（不会显示内容）' : '未设置'}`);
  out.push(line());

  // 1) 离线自检：演示流水线必须能跑通
  try {
    const demoResult = buildPlanDemo({ budgetYuan: 30 });
    const svg = renderReport(demoResult);
    out.push(`  ✅ 离线流水线正常：枚举 ${demoResult.stats.totalPlans} 个方案，推荐 ${demoResult.recommendations.length} 个，`
      + `SVG ${svg.length} 字节`);
  } catch (err) {
    out.push(`  ❌ 离线流水线失败：${err.message}`);
    return { ok: false, output: out.join('\n') };
  }

  if (!token) {
    out.push('');
    out.push('  未检测到 MCD_MCP_TOKEN，跳过在线检查。');
    out.push('  申请方式：https://open.mcd.cn/mcp → 右上角登录 → 控制台 → 激活 → 复制 Token');
    out.push('  设置方式：PowerShell  $env:MCD_MCP_TOKEN = "你的Token"');
    out.push('  然后运行：mcd-dual doctor');
    out.push(line('═'));
    return { ok: true, output: out.join('\n') };
  }

  const client = new McpClient({ endpoint: options.endpoint ?? DEFAULT_ENDPOINT, token, minIntervalMs: 120 });
  try {
    const handshake = await client.connect();
    out.push('');
    out.push('  在线检查');
    out.push(`    ✅ 握手成功：协议 ${handshake.protocolVersion ?? '未返回'}`
      + `　服务端 ${handshake.serverInfo?.name ?? '未知'} ${handshake.serverInfo?.version ?? ''}`);

    const registry = new ToolRegistry(client);
    const tools = await registry.load();
    out.push(`    ✅ 工具清单：共 ${tools.size} 个`);

    const missing = [...READ_ONLY_TOOLS].filter((name) => !registry.has(name));
    out.push(`    只读白名单覆盖：${READ_ONLY_TOOLS.size - missing.length}/${READ_ONLY_TOOLS.size}`);
    if (missing.length) out.push(`    未暴露（可能版本差异）：${missing.join('、')}`);

    if (registry.has('now-time-info')) {
      const res = await registry.call('now-time-info', {});
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? res.raw).slice(0, 120);
      out.push(`    ✅ 只读工具连通性测试（now-time-info）：${text}`);
    }

    if (options['dump-schema']) {
      const target = resolve(String(options['dump-schema']));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(tools, null, 2), 'utf8');
      out.push(`    📄 工具 schema 已导出：${target}（不含 Token，可安全分享）`);
    }

    out.push(`    请求统计：${JSON.stringify(summarizeCalls(registry.callLog))}`);
    out.push('');
    out.push('  自检通过。可以运行： mcd-dual plan --budget 30 --city <你的城市> --store <门店关键词>');
    out.push(line('═'));
    return { ok: true, output: out.join('\n') };
  } catch (err) {
    const hint = err instanceof McpError && err.hint ? `\n    提示：${err.hint}` : '';
    out.push('');
    out.push(`    ❌ 在线检查失败：${err.message}${hint}`);
    out.push(line('═'));
    return { ok: false, output: out.join('\n') };
  }
}

async function cmdPlan(options) {
  const token = process.env.MCD_MCP_TOKEN;
  const useDemo = options.demo === true || (!token && options.live !== true);

  let result;
  if (useDemo) {
    result = buildPlanDemo({
      budgetYuan: options.budget ?? 30,
      kcal: options.kcal,
      protein: options.protein,
      sodium: options.sodium,
      kcalTolerance: options.tolerance,
      minScore: options['min-score'],
      perCategory: options['per-category'],
    });
    if (!token) {
      result.dataNotes = [
        ...result.dataNotes,
        '未检测到 MCD_MCP_TOKEN，已自动使用演示模式；设置 Token 后即切换为官方实时数据。',
      ];
    }
  } else {
    const client = new McpClient({
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
      token,
      minIntervalMs: Number(options['min-interval-ms'] ?? 120),
      timeoutMs: Number(options['timeout-ms'] ?? 30_000),
    });
    const registry = new ToolRegistry(client);
    await registry.load();
    result = await buildPlanLive(registry, {
      budgetYuan: options.budget ?? 30,
      kcal: options.kcal,
      protein: options.protein,
      sodium: options.sodium,
      kcalTolerance: options.tolerance,
      minScore: options['min-score'],
      perCategory: options['per-category'],
      city: options.city,
      storeKeyword: options.store,
      storeCode: options['store-code'],
      beType: options['be-type'] !== undefined ? Number(options['be-type']) : undefined,
      searchType: options['search-type'] !== undefined ? Number(options['search-type']) : undefined,
      comboLookupLimit: options['combo-limit'] !== undefined ? Number(options['combo-limit']) : undefined,
      verify: options.verify !== false,
      endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    });
  }

  if (result.recommendations.length === 0) {
    const reason = result.stats.withinBudget === 0
      ? '预算内没有可行组合，请提高 --budget 或放宽营养目标。'
      : '没有方案达到营养门槛，可降低 --min-score 或放宽 --kcal/--protein。';
    throw new Error(`未找到可推荐方案：${reason}`);
  }

  const svg = renderReport(result);
  const outPath = resolve(String(options.out ?? join('reports', 'report.svg')));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, svg, 'utf8');

  let jsonPath = null;
  if (options.json) {
    jsonPath = resolve(String(options.json));
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  }

  if (options.quiet) return { ok: true, output: outPath };
  return { ok: true, output: printPlanSummary(result, { outPath, jsonPath }) };
}

async function main() {
  const { options, positionals } = parseArgs(process.argv.slice(2));
  const command = positionals[0] ?? 'help';

  if (options.help || command === 'help') {
    console.log(HELP);
    return 0;
  }

  try {
    if (command === 'doctor') {
      const { ok, output } = await cmdDoctor(options);
      console.log(output);
      return ok ? 0 : 1;
    }
    if (command === 'plan') {
      const { output } = await cmdPlan(options);
      console.log(output);
      return 0;
    }
    console.error(`未知命令：${command}\n`);
    console.log(HELP);
    return 2;
  } catch (err) {
    const hint = err instanceof McpError && err.hint ? `\n提示：${err.hint}` : '';
    console.error(`\n❌ ${err.message}${hint}\n`);
    return 1;
  }
}

process.exitCode = await main();
