#!/usr/bin/env node
/**
 * 离线深度审计：边界 / 单调性 / 可复现性 / 诚实性
 * ---------------------------------------------------------------
 * 为什么要有它：
 *   多门店验证回答「换一家店还能不能算对」，但不回答「把参数推到极端会不会
 *   悄悄给错答案」。用户最容易受伤的不是结果不够优，而是**无解时说有解、
 *   截断时当完整、退化时不声明**。这里用已抓取的门店快照（零 MCP 请求）
 *   把参数推到边界，逐条断言这些诚实性约束。
 *
 * 注意：文件名刻意不含 "test"，否则 `node --test` 会把这份需要跑几十秒的
 * 审计脚本当成单元测试一起执行。
 *
 * 用法：
 *   node tools/deep-audit.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { solve, meetsUserTargets } from '../src/solver.mjs';
import { matchNutrition } from '../src/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const STORE_DIR = resolve(ROOT, 'examples/stores');
const BASELINE = resolve(ROOT, 'examples/live-snapshot.json');

const FEN = 100;
const yuan = (fen) => (fen == null ? '—' : (fen / FEN).toFixed(2));

function loadSnapshot(path) {
  const snap = JSON.parse(readFileSync(path, 'utf8'));
  const items = snap.menu ?? [];
  const index = matchNutrition(items, snap.nutrition ?? []);
  // 快照里的 matches 是抓取时按同一套规则解析出来的（含套餐拆解），以它为准，
  // 保证离线复现与线上口径一致。
  for (const entry of snap.matches ?? []) {
    const item = items.find((m) => String(m.code) === String(entry.code));
    if (item) index.set(item, { nutrition: entry.nutrition ?? null, matchType: entry.matchType ?? 'none', matchedName: entry.matchedName ?? null });
  }
  return { ...snap, items, index };
}

function run(snap, { budgetFen, targets, perCategory } = {}) {
  return solve({
    items: snap.items,
    nutritionByItem: snap.index,
    targets: targets ? { ...snap.targets, ...targets } : snap.targets,
    budgetFen: budgetFen ?? snap.budgetFen,
    coupons: (snap.coupons ?? []).filter((c) => c.usable),
    perCategory: perCategory ?? 5,
  });
}

const byKind = (res) => Object.fromEntries((res.recommendations ?? []).map((r) => [r.kind, r]));
const payableOf = (r) => (r ? (r.totals?.payableFen ?? r.payableFen ?? r.totals?.priceFen ?? null) : null);

function main() {
  const snapshots = [];
  if (readdirSync(STORE_DIR, { withFileTypes: true }).length) {
    for (const f of readdirSync(STORE_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { snapshots.push(loadSnapshot(join(STORE_DIR, f))); } catch { /* 跳过坏文件 */ }
    }
  }
  if (!snapshots.length) snapshots.push(loadSnapshot(BASELINE));
  const baseline = snapshots.find((s) => String(s.store?.code) === '3450410') ?? snapshots[0];

  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });
  const label = (s) => `${s.city ?? ''}${s.store?.name ?? s.store?.code ?? '?'}`;

  // ---------------------------------------------------------- 1. 预算扫描
  const budgets = [500, 1000, 1500, 2000, 3000, 5000, 10000];
  const budgetRows = [];
  for (const snap of snapshots) {
    const row = { store: label(snap), cells: [] };
    for (const b of budgets) {
      const res = run(snap, { budgetFen: b });
      const k = byKind(res);
      row.cells.push({
        budgetYuan: b / FEN,
        withinBudget: res.stats.withinBudget,
        qualifying: res.stats.qualifying,
        basis: res.stats.qualifyingBasis,
        truncated: res.stats.truncated,
        double: payableOf(k.valueBest),
        top: payableOf(k.topScore),
        cheap: payableOf(k.cheapest),
        recCount: res.recommendations.length,
      });
    }
    budgetRows.push(row);
  }

  // 诚实性：预算极低时必须承认无解，而不是硬凑一个
  let noSolutionHonest = true;
  let monotonicOk = true;
  let priceSaneOk = true;
  for (const row of budgetRows) {
    for (const c of row.cells) {
      if (c.withinBudget === 0 && c.recCount > 0) noSolutionHonest = false;
      for (const v of [c.double, c.top, c.cheap]) {
        if (v != null && v < 0) priceSaneOk = false;
      }
    }
    for (let i = 1; i < row.cells.length; i += 1) {
      const prev = row.cells[i - 1];
      const cur = row.cells[i];
      if (cur.withinBudget < prev.withinBudget) monotonicOk = false;
      if (prev.cheap != null && cur.cheap != null && cur.cheap > prev.cheap) monotonicOk = false;
    }
  }
  record('预算极低时如实报「无解」（不硬凑推荐）', noSolutionHonest, '预算 ¥5 时 withinBudget=0 ⇒ recommendations 必须为空');
  record('预算单调性（预算↑ ⇒ 预算内方案数不降、省钱底线不升）', monotonicOk, '逐店逐档比较');
  record('价格非负（券不会把价格算成负数）', priceSaneOk, '所有推荐 payableFen ≥ 0');

  // ---------------------------------------------------------- 2. 营养目标极限
  const nutritionCases = [
    { name: '蛋白 20 g（宽松）', targets: { proteinG: 20 } },
    { name: '蛋白 45 g（偏严）', targets: { proteinG: 45 } },
    { name: '蛋白 60 g（极严）', targets: { proteinG: 60 } },
    { name: '钠 ≤ 600 mg（极严）', targets: { sodiumMaxMg: 600 } },
    { name: '钠 ≤ 2000 mg（宽松）', targets: { sodiumMaxMg: 2000 } },
    { name: '热量容差 ±5%', targets: { kcalTolerance: 0.05 } },
    { name: '热量容差 ±50%', targets: { kcalTolerance: 0.5 } },
  ];
  const nutritionRows = nutritionCases.map((c) => {
    const res = run(baseline, { budgetFen: 5000, targets: c.targets, perCategory: 5 });
    const k = byKind(res);
    const value = k.valueBest ?? null;
    const met = value ? meetsUserTargets(value) : null;
    return {
      name: c.name,
      withinBudget: res.stats.withinBudget,
      qualifying: res.stats.qualifying,
      basis: res.stats.qualifyingBasis,
      doubleYuan: yuan(payableOf(value)),
      proteinG: value?.totals?.proteinG ?? null,
      sodiumMg: value?.totals?.sodiumMg ?? null,
      kcal: value?.totals?.energyKcal ?? null,
      hardMet: met,
    };
  });

  // 诚实性：标称 hard-targets 时，双赢推荐必须真的满足硬目标
  const valueRows = nutritionRows.filter((r) => r.doubleYuan !== '—');
  const hardHonest = nutritionRows.every((r) => r.basis !== 'hard-targets' || r.hardMet !== false);
  record('标称 hard-targets 时双赢推荐确实满足用户硬目标', hardHonest,
    `检查 ${valueRows.length} 个档位；退化时必须显式标 score-fallback`);

  // ---------------------------------------------------------- 3. 截断边界与自动降级
  const perCategories = [3, 4, 5, 6, 7, 8, 10];
  const truncRows = perCategories.map((pc) => {
    const res = run(baseline, { budgetFen: 4000, perCategory: pc });
    const adj = res.stats.perCategoryAdjusted;
    return {
      requested: pc,
      used: adj ? adj.used : pc,
      candidates: res.stats.candidateCount,
      enumerated: res.stats.enumerated,
      truncated: res.stats.truncated,
      adjusted: Boolean(adj),
    };
  });
  const truncVisible = truncRows.every((r) => !(r.enumerated >= 400000) || r.truncated === true);
  record('搜索截断必被标记（enumerated 达上限 ⇒ truncated=true）', truncVisible, '逐档核对 perCategory 3~10');
  record('自动降级必被记录（requseted > used 时留痕）', truncRows.every((r) => !r.adjusted || r.used < r.requested),
    '截断时自动下调候选规模，并在 stats.perCategoryAdjusted 留痕');
  record('降级后必须不再截断（用「候选略少但枚举完整」换掉「候选多但有偏」）',
    truncRows.every((r) => !(r.adjusted && r.truncated)), '降级成功的档位 truncated 应为 false');

  // ---------------------------------------------------------- 4. 可复现性
  let reproducible = true;
  for (const snap of snapshots.slice(0, 3)) {
    const a = run(snap, { budgetFen: 4000, perCategory: 5 });
    const b = run(snap, { budgetFen: 4000, perCategory: 5 });
    const same = JSON.stringify(a.recommendations) === JSON.stringify(b.recommendations)
      && JSON.stringify(a.stats) === JSON.stringify(b.stats);
    if (!same) reproducible = false;
  }
  record('可复现性（同参数两次求解结果完全一致）', reproducible, '取前 3 家门店比对 recommendations + stats');

  // ---------------------------------------------------------- 5. 券金额合理性
  // 注意：stats.couponApplied 是「用上了券的方案数」，一张券可以覆盖成千上万个方案，
  // 因此它天然可以远大于券的总数 —— 不能用它来断言"券不超发"（那是错误断言）。
  // 真正该守住的是金额：折扣必须非负，且不能超过订单本身。
  const couponChecks = snapshots.map((snap) => {
    const res = run(snap, { budgetFen: snap.budgetFen ?? 4000 });
    const discountSane = (res.recommendations ?? []).every((r) => {
      const d = r.totals?.discountFen ?? 0;
      const p = r.totals?.priceFen ?? 0;
      return d >= 0 && d <= p;
    });
    return {
      store: label(snap),
      couponCount: res.stats.couponCount,
      couponAppliedPlans: res.stats.couponApplied,
      discountSane,
    };
  });
  record('券折扣金额合理（0 ≤ 折扣 ≤ 订单金额）', couponChecks.every((c) => c.discountSane), '逐店核对推荐方案的折扣');

  // ---------------------------------------------------------- 输出
  const report = {
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    storeCount: snapshots.length,
    budgetRows,
    nutritionRows,
    truncRows,
    couponChecks,
    checks,
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
  };

  mkdirSync(resolve(ROOT, 'examples'), { recursive: true });
  writeFileSync(resolve(ROOT, 'examples/deep-audit-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // ---- 终端 ----
  console.log(`\n深度测试：${snapshots.length} 家门店快照（零 MCP 请求）`);
  console.log('\n[1] 预算扫描（三结论均为券后实付，元）');
  for (const row of budgetRows) {
    console.log(`  ${row.store}`);
    console.log(`    ${budgets.map((b) => `¥${b / FEN}`).join('  ')}`);
    console.log(`    双赢 ${row.cells.map((c) => c.double == null ? '—' : yuan(c.double)).join('  ')}`);
    console.log(`    省钱 ${row.cells.map((c) => c.cheap == null ? '—' : yuan(c.cheap)).join('  ')}`);
    console.log(`    达标 ${row.cells.map((c) => c.qualifying).join('  ')}`);
  }
  console.log('\n[2] 营养目标极限（基线店，预算 ¥50）');
  for (const r of nutritionRows) {
    console.log(`  ${r.name.padEnd(20)} 预算内 ${String(r.withinBudget).padStart(5)} · 达标 ${String(r.qualifying).padStart(4)}`
      + ` · 双赢 ¥${r.doubleYuan} · ${r.proteinG ?? '—'}g 蛋白 / ${r.sodiumMg ?? '—'}mg 钠 / ${r.kcal ?? '—'}kcal · 硬目标${r.hardMet === true ? '✓' : r.hardMet === false ? '✗' : '—'}`);
  }
  console.log('\n[3] 截断边界与自动降级（基线店，预算 ¥40）');
  for (const r of truncRows) {
    console.log(`  请求 perCategory=${String(r.requested).padStart(2)} → 实际 ${String(r.used).padStart(2)}`
      + ` · 候选 ${String(r.candidates).padStart(3)} · 枚举 ${String(r.enumerated).padStart(7)}`
      + `${r.adjusted ? ' 【已自动降级】' : ''}${r.truncated ? ' 【截断】' : ''}`);
  }
  console.log('\n[4] 诚实性断言');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}　—　${c.detail}`);
  console.log(`\n  通过 ${report.passed} / ${checks.length}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
