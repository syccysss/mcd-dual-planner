import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  solve, scorePlan, sumPlan, selectCandidates, paretoFront,
  couponSaving, pickBestCouponForPlan, meetsUserTargets,
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

test('solve：营养未知品可进入候选，省钱底线是真正的绝对最便宜', () => {
  const { items, nutritionByItem } = makeFixture();
  // 无营养主食 ¥9.00 比最便宜的有营养主食（吉士汉堡 ¥12.50）更便宜
  const mystery = { name: '神秘新品堡', code: 'X1', priceFen: 900, category: '主食' };
  const mysterySnack = { name: '神秘甜品', code: 'X2', priceFen: 100, category: '甜品' };
  items.push(mystery, mysterySnack);
  nutritionByItem.set(mystery, { nutrition: null, matchType: 'none', matchedName: null });
  nutritionByItem.set(mysterySnack, { nutrition: null, matchType: 'none', matchedName: null });

  const result = solve({ items, nutritionByItem, budgetFen: 5000, minScore: 60 });
  const cheapest = result.recommendations.find((p) => p.kind === 'cheapest');
  assert.ok(cheapest, '省钱底线应存在');
  assert.ok(cheapest.items.some((i) => i.code === 'X1'), '营养未知的最便宜主食应进入省钱底线');
  assert.equal(cheapest.totals.priceFen, 900, '省钱底线价格应为营养未知主食的 900 分');
  assert.ok(cheapest.totals.unknownItems > 0, '方案应如实标注营养未知项数');
  // 营养未知品不应破坏营养类推荐的门槛
  const valueBest = result.recommendations.find((p) => p.kind === 'valueBest');
  assert.ok(valueBest);
  assert.ok(valueBest.totals.unknownItems === 0, '双赢推荐不应包含营养未知品');
  // 候选统计如实反映未知品保留情况
  const dessert = result.stats.candidateStats.find((s) => s.category === '甜品');
  assert.ok(dessert.unknownKept >= 1);
});

test('solve：券纳入目标 —— 券后实付最低才是"省钱底线"，哪怕菜单价不是最低', () => {
  const { items, nutritionByItem } = makeFixture();
  // 满 20 减 10：单价 ¥12.50 的吉士汉堡不够门槛（无券），¥21.50 的巨无霸够门槛（−¥10）
  const coupons = [{ id: 'C1', name: '满20减10', discountFen: 1000, thresholdFen: 2000 }];
  const result = solve({ items, nutritionByItem, budgetFen: 3000, minScore: 60, coupons });

  const cheapest = result.recommendations.find((p) => p.kind === 'cheapest');
  assert.ok(cheapest);
  // 省钱底线 = 所有预算内方案里券后实付最低的
  const minPayable = Math.min(...result.plans.map((p) => p.totals.payableFen));
  assert.equal(cheapest.totals.payableFen, minPayable);
  // 该方案确实用了券，且券后实付低于"菜单价最低的方案"（¥12.50）——证明是券改变了结论
  assert.ok(cheapest.totals.discountFen > 0, '省钱底线应使用优惠券');
  assert.equal(cheapest.coupon.id, 'C1');
  const minMenu = Math.min(...result.plans.map((p) => p.totals.priceFen));
  assert.ok(cheapest.totals.payableFen < minMenu,
    `券后实付（${cheapest.totals.payableFen}）应低于任何方案的菜单价（最低 ${minMenu}）`);
  assert.equal(cheapest.totals.priceFen, cheapest.totals.payableFen + cheapest.totals.discountFen);

  // 无券时成本口径退化为菜单价，向后兼容
  const noCoupon = solve({ items, nutritionByItem, budgetFen: 3000, coupons: [] });
  for (const plan of noCoupon.plans) {
    assert.equal(plan.totals.payableFen, plan.totals.priceFen);
    assert.equal(plan.totals.discountFen, 0);
  }
});

test('solve：预算卡券前菜单价 —— 不能靠券把超预算的方案"救"进结果', () => {
  const { items, nutritionByItem } = makeFixture();
  const coupons = [{ id: 'C1', name: '满30减12', discountFen: 1200, thresholdFen: 3000 }];
  const result = solve({ items, nutritionByItem, budgetFen: 2000, coupons });
  for (const plan of result.plans) {
    assert.ok(plan.totals.priceFen <= 2000, `菜单价必须落在预算内：${plan.totals.priceFen}`);
  }
  assert.equal(result.stats.couponCount, 1);
  assert.ok(result.stats.costBasis.includes('券后实付'));
});

test('paretoFront：前沿改用券后实付作为成本轴', () => {
  const plans = [
    { totals: { priceFen: 2000, payableFen: 1000 }, score: 60 },
    { totals: { priceFen: 1500, payableFen: 1500 }, score: 50 },
  ];
  const front = paretoFront(plans);
  assert.equal(front[0].totals.payableFen, 1000, '券后实付更低的点应排在前面');
  assert.deepEqual(front.map((p) => p.score), [60]);
});

test('couponSaving：商品级用券价按「原价 − 用券价」计算，方案不含该商品则不省', () => {
  const coupon = { id: 'W1', name: '薯条任选', couponPriceFen: 990, appliesToCode: 'F1' };
  const withTarget = [{ code: 'F1', priceFen: 1300 }, { code: 'B2', priceFen: 1250 }];
  const withoutTarget = [{ code: 'B2', priceFen: 1250 }];
  assert.equal(couponSaving(coupon, withTarget), 310);
  assert.equal(couponSaving(coupon, withoutTarget), 0);
  // 用券价高于原价时不得出现「负优惠」
  assert.equal(couponSaving({ couponPriceFen: 2000, appliesToCode: 'F1' }, withTarget), 0);
  // 订单级满减仍可用，且不会把订单减成负数
  assert.equal(couponSaving({ discountFen: 500, thresholdFen: 0 }, [{ priceFen: 300 }]), 300);
  assert.equal(couponSaving({ discountFen: 500, thresholdFen: 9999 }, [{ priceFen: 1300 }]), 0);
  // 无券
  assert.equal(couponSaving(null, withTarget), 0);
});

test('pickBestCouponForPlan：选省得最多的那张券，无可用券返回 null', () => {
  const coupons = [
    { id: 'A', name: '减3', discountFen: 300, thresholdFen: 0 },
    { id: 'B', name: '薯条券价', couponPriceFen: 990, appliesToCode: 'F1' },
  ];
  const plan = [{ code: 'F1', priceFen: 1300 }];
  assert.equal(pickBestCouponForPlan(coupons, plan).id, 'B'); // 省 310 > 300
  assert.equal(pickBestCouponForPlan([], plan), null);
  assert.equal(pickBestCouponForPlan([{ id: 'C', discountFen: 500, thresholdFen: 9999 }], plan), null);
});

test('solve：商品级用券价生效后，含该商品的方案券后实付下降', () => {
  const { items, nutritionByItem } = makeFixture();
  // 薯条 1300 → 用券价 990，省 310
  const coupons = [{ id: 'W1', name: '薯条任选', couponPriceFen: 990, appliesToCode: 'F1' }];
  const result = solve({ items, nutritionByItem, budgetFen: 3000, coupons });
  assert.ok(result.stats.couponApplied > 0, '应有预算内方案用券降低成本');
  const planWithFries = result.plans.find((p) => p.items.some((i) => i.code === 'F1'));
  assert.ok(planWithFries, '应存在含薯条的方案');
  assert.equal(planWithFries.discountFen, 310);
  assert.equal(planWithFries.totals.payableFen, planWithFries.totals.priceFen - 310);
  const planNoFries = result.plans.find((p) => !p.items.some((i) => i.code === 'F1'));
  assert.equal(planNoFries.discountFen, 0, '不含目标商品的方案不应降价');
});

test('meetsUserTargets：达标 = 用户硬目标全满足，复合得分再高也不算', () => {
  // 真实数据里出现过的事故：蛋白 29 g（用户要 ≥30 g）因总分 83.6 被标成「达标」
  assert.equal(meetsUserTargets({ score: 83.6, checks: { kcalInRange: true, proteinMet: false, sodiumOk: true, fatOk: false } }), false);
  // 脂肪是推导出来的软性控制项，不参与达标判定
  assert.equal(meetsUserTargets({ score: 60, checks: { kcalInRange: true, proteinMet: true, sodiumOk: true, fatOk: false } }), true);
  // 营养未知（null）不等于达标 —— 不能拿"没数据"冒充"合格"
  assert.equal(meetsUserTargets({ score: 90, checks: { kcalInRange: null, proteinMet: null, sodiumOk: null, fatOk: null } }), false);
});

test('solve：双赢推荐必须是「硬目标全满足里券后最便宜」的那个，而不是「得分高」的那个', () => {
  const { items, nutritionByItem } = makeFixture();
  const result = solve({ items, nutritionByItem, budgetFen: 4500, targets: { ...DEFAULT_TARGETS } });
  const valueBest = result.recommendations.find((r) => r.kind === 'valueBest');
  assert.ok(valueBest, '应存在双赢推荐');
  assert.equal(meetsUserTargets(valueBest), true,
    `双赢推荐必须满足全部硬目标，实际 checks=${JSON.stringify(valueBest.checks)}`);
  assert.ok(valueBest.totals.proteinG >= DEFAULT_TARGETS.proteinG);
  assert.equal(result.stats.qualifyingBasis, 'hard-targets');
  // 硬目标口径更严，达标数不应超过「得分达标」数
  assert.ok(result.stats.hardQualifying <= result.stats.scoreQualifying);
});

test('solve：目标过严导致无人达标时，退化为得分门槛并如实标注 qualifyingBasis', () => {
  const { items, nutritionByItem } = makeFixture();
  const result = solve({
    items, nutritionByItem, budgetFen: 4500,
    targets: { kcal: 700, kcalTolerance: 0.01, proteinG: 200, sodiumMaxMg: 50 },
  });
  assert.equal(result.stats.hardQualifying, 0, '该目标下不应有方案达标');
  assert.equal(result.stats.qualifyingBasis, 'score-fallback', '必须如实标注已退化');
});

test('solve：搜索截断时自动下调候选规模重算，而不是返回被砍断的结果', () => {
  // 构造一个必然撞上 40 万方案上限的菜单：四类各 24/24/10/10 项，
  // 且刻意让「最便宜 / 蛋白性价比 / 蛋白最高 / 钠最低」四个方向互不重叠，
  // 从而每类都保留满 perCategory 个候选，组合数远超上限。
  const items = [];
  const nutritionByItem = new Map();
  const spec = { 主食: 24, 小食: 24, 饮料: 10, 甜品: 10 };
  const shape = (i) => {
    if (i < 6) return { energyKcal: 100, proteinG: 1, sodiumMg: 1000 };
    if (i < 12) return { energyKcal: 300, proteinG: 100, sodiumMg: 1000 };
    if (i < 18) return { energyKcal: 600, proteinG: 500, sodiumMg: 1000 };
    return { energyKcal: 200, proteinG: 10, sodiumMg: 1 };
  };
  let base = 100;
  for (const [category, count] of Object.entries(spec)) {
    for (let i = 0; i < count; i += 1) {
      const nutrition = shape(i);
      const item = { code: `${category}${i}`, name: `${category}${i}`, priceFen: base + i * 10 + (i >= 12 ? 3000 : 0), category };
      items.push(item);
      nutritionByItem.set(item, { nutrition, matchType: 'test', matchedName: item.name });
    }
    base += 500;
  }

  const result = solve({ items, nutritionByItem, budgetFen: 10_000_000, perCategory: 6, maxResults: 5 });
  assert.equal(result.stats.truncated, false, '自动降级后不应再出现截断');
  assert.ok(result.stats.enumerated < 400_000, `枚举量应低于硬上限，实际 ${result.stats.enumerated}`);
  const adj = result.stats.perCategoryAdjusted;
  assert.ok(adj, '发生降级时必须留下 perCategoryAdjusted 记录，便于战报如实说明');
  assert.ok(adj.used < adj.requested, '降级后的候选规模必须小于请求值');
  assert.ok(result.recommendations.length > 0, '降级后仍应给出推荐');
});
