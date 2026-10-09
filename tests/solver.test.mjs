import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  solve, scorePlan, sumPlan, selectCandidates, paretoFront,
  DEFAULT_TARGETS, DEFAULT_RULES, DEFAULT_WEIGHTS,
} from '../src/solver.mjs';

/** 造一份小菜单，价格与营养都手工可控，便于断言 */
function makeFixture() {
  const items = [
    { name: '巨无霸', code: 'B1', priceFen: 2150, category: '主食' },
    { name: '吉士汉堡', code: 'B2', priceFen: 1250, category: '主食' },
    { name: '麦香鱼', code: 'B3', priceFen: 1650, category: '主食' },
    { name: '薯条', code: 'F1', priceFen: 1300, category: '小食' },
    { name: '玉米杯', code: 'F2', priceFen: 950, category: '小食' },
    { name: '可乐', code: 'D1', priceFen: 950, category: '饮料' },
    { name: '纯牛奶', code: 'D2', priceFen: 900, category: '饮料' },
    { name: '圆筒冰淇淋', code: 'S1', priceFen: 400, category: '甜品' },
  ];
  const nutrition = {
    B1: { energyKcal: 550, proteinG: 26, fatG: 29, carbG: 45, sodiumMg: 1050 },
    B2: { energyKcal: 300, proteinG: 15, fatG: 13, carbG: 30, sodiumMg: 700 },
    B3: { energyKcal: 340, proteinG: 15, fatG: 16, carbG: 34, sodiumMg: 700 },
    F1: { energyKcal: 340, proteinG: 4, fatG: 16, carbG: 43, sodiumMg: 270 },
    F2: { energyKcal: 100, proteinG: 3, fatG: 2, carbG: 20, sodiumMg: 5 },
    D1: { energyKcal: 150, proteinG: 0, fatG: 0, carbG: 38, sodiumMg: 15 },
    D2: { energyKcal: 130, proteinG: 7, fatG: 5, carbG: 10, sodiumMg: 90 },
    S1: { energyKcal: 150, proteinG: 4, fatG: 5, carbG: 22, sodiumMg: 70 },
  };
  const nutritionByItem = new Map();
  for (const item of items) {
    nutritionByItem.set(item, { nutrition: nutrition[item.code], matchType: 'exact', matchedName: item.name });
  }
  return { items, nutritionByItem };
}

test('sumPlan：总价与总营养逐项累加，缺失字段被计数而不是当 0 蒙过去', () => {
  const { items, nutritionByItem } = makeFixture();
  const totals = sumPlan([items[0], items[5]], nutritionByItem);
  assert.equal(totals.priceFen, 3100);
  assert.equal(totals.energyKcal, 700);
  assert.equal(totals.proteinG, 26);
  assert.equal(totals.sodiumMg, 1065);
  assert.equal(totals.unknownItems, 0);

  const unknown = sumPlan([{ name: '神秘餐品', priceFen: 500, code: 'X' }], nutritionByItem);
  assert.equal(unknown.unknownItems, 1);
});

test('scorePlan：正中目标得高分，钠超标要扣分', () => {
  const good = scorePlan({ energyKcal: 700, proteinG: 30, fatG: 25, sodiumMg: 900 }, DEFAULT_TARGETS, DEFAULT_WEIGHTS);
  assert.ok(good.score > 85, `期望高分，实际 ${good.score}`);
  assert.ok(good.checks.kcalInRange && good.checks.proteinMet && good.checks.sodiumOk);

  const salty = scorePlan({ energyKcal: 700, proteinG: 30, fatG: 25, sodiumMg: 3000 }, DEFAULT_TARGETS, DEFAULT_WEIGHTS);
  assert.ok(salty.score < good.score, '钠超标应当拉低得分');
  assert.equal(salty.checks.sodiumOk, false);
  assert.ok(salty.parts.sodiumPenalty > 0);

  const offTarget = scorePlan({ energyKcal: 1500, proteinG: 5, fatG: 60, sodiumMg: 900 }, DEFAULT_TARGETS, DEFAULT_WEIGHTS);
  assert.ok(offTarget.score < 40, `期望低分，实际 ${offTarget.score}`);
  assert.equal(offTarget.checks.kcalInRange, false);
});

test('scorePlan：得分被夹在 0~100 之间', () => {
  const extreme = scorePlan({ energyKcal: 700, proteinG: 200, fatG: 0, sodiumMg: 0 }, DEFAULT_TARGETS, DEFAULT_WEIGHTS);
  assert.ok(extreme.score <= 100 && extreme.score >= 0);
});

test('selectCandidates：按品类裁剪，且最便宜的餐品一定入选', () => {
  const { items, nutritionByItem } = makeFixture();
  const { candidates, stats } = selectCandidates(items, nutritionByItem, { perCategory: 1 });
  const mains = candidates.filter((c) => c.category === '主食');
  assert.ok(mains.some((m) => m.code === 'B2'), '最便宜的主食必须留在候选集里');
  const stat = stats.find((s) => s.category === '主食');
  assert.equal(stat.inMenu, 3);
  assert.ok(stat.kept <= 3);
});

test('paretoFront：前沿上的点价格递增、得分严格递增', () => {
  const plans = [
    { totals: { priceFen: 1000 }, score: 50 },
    { totals: { priceFen: 1000 }, score: 40 },
    { totals: { priceFen: 2000 }, score: 70 },
    { totals: { priceFen: 1500 }, score: 60 },
    { totals: { priceFen: 3000 }, score: 65 },
  ];
  const front = paretoFront(plans);
  assert.deepEqual(front.map((p) => p.score), [50, 60, 70]);
  for (let i = 1; i < front.length; i += 1) {
    assert.ok(front[i].totals.priceFen > front[i - 1].totals.priceFen);
    assert.ok(front[i].score > front[i - 1].score);
  }
});

test('solve：所有方案都不超预算，推荐方案互不重复', () => {
  const { items, nutritionByItem } = makeFixture();
  const result = solve({ items, nutritionByItem, budgetFen: 3000 });
  assert.ok(result.totalPlans > 0);
  for (const plan of result.plans) assert.ok(plan.totals.priceFen <= 3000);
  const signatures = result.recommendations.map((p) => p.items.map((i) => i.code).sort().join('|'));
  assert.equal(new Set(signatures).size, signatures.length);
});

test('solve：品类规则生效 —— 至少一个主食、小食不超过上限', () => {
  const { items, nutritionByItem } = makeFixture();
  const result = solve({ items, nutritionByItem, budgetFen: 5000, rules: DEFAULT_RULES });
  for (const plan of result.plans) {
    const counts = {};
    for (const item of plan.items) counts[item.category] = (counts[item.category] ?? 0) + 1;
    assert.equal(counts['主食'] ?? 0, 1);
    assert.ok((counts['小食'] ?? 0) <= 2);
    assert.ok((counts['饮料'] ?? 0) <= 1);
    assert.ok((counts['甜品'] ?? 0) <= 1);
  }
});

test('solve：双赢推荐 = 达到门槛的方案里最便宜的那个', () => {
  const { items, nutritionByItem } = makeFixture();
  const result = solve({ items, nutritionByItem, budgetFen: 4000, minScore: 60 });
  const qualifying = result.plans.filter((p) => p.score >= 60);
  assert.ok(qualifying.length > 0);
  const cheapestQualifying = Math.min(...qualifying.map((p) => p.totals.priceFen));
  const valueBest = result.recommendations[0];
  assert.equal(valueBest.totals.priceFen, cheapestQualifying);
  assert.ok(valueBest.score >= 60);
});

test('solve：预算收紧后可行方案不会变多', () => {
  const { items, nutritionByItem } = makeFixture();
  const wide = solve({ items, nutritionByItem, budgetFen: 4000 });
  const tight = solve({ items, nutritionByItem, budgetFen: 2000 });
  assert.ok(tight.withinBudget <= wide.withinBudget);
  for (const plan of tight.plans) assert.ok(plan.totals.priceFen <= 2000);
});

test('solve：同样输入两次求解结果完全一致（可复现）', () => {
  const a = solve({ ...makeFixture(), budgetFen: 3000 });
  const b = solve({ ...makeFixture(), budgetFen: 3000 });
  assert.equal(a.totalPlans, b.totalPlans);
  assert.equal(a.stats.qualifying, b.stats.qualifying);
  assert.deepEqual(
    a.recommendations.map((p) => p.items.map((i) => i.code).sort()),
    b.recommendations.map((p) => p.items.map((i) => i.code).sort()),
  );
});

test('solve：统计信息如实反映裁剪与枚举规模', () => {
  const { items, nutritionByItem } = makeFixture();
  const result = solve({ items, nutritionByItem, budgetFen: 3000 });
  assert.equal(result.stats.candidateCount, items.length);
  assert.equal(result.stats.budgetFen, 3000);
  assert.ok(result.stats.dominanceNote.includes('裁剪'));
  assert.equal(result.stats.truncated, false);
});
