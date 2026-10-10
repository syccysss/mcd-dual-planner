import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPlanDemo, buildSolverOptions, pickBestCoupon, extractComboParts, extractMenuCodes,
  dedupeCoupons, isPlausibleCombo } from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { demoDataset } from '../src/demo-data.mjs';

test('演示流水线：从数据到战报全链路可跑通', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  assert.equal(result.meta.mode, 'demo');
  assert.ok(result.recommendations.length >= 1);
  assert.ok(result.recommendations.length <= 3);
  assert.equal(result.coverage.menuTotal, demoDataset().menu.length);
  assert.equal(result.coverage.unmatched, 0);
  const svg = renderReport(result);
  assert.ok(svg.length > 5000);
});

test('演示流水线：所有推荐方案都在预算内', () => {
  const result = buildPlanDemo({ budgetYuan: 25 });
  for (const plan of result.recommendations) {
    assert.ok(plan.totals.priceFen <= 2500, `方案超预算：${plan.totals.priceFen}`);
  }
});

test('演示数据自带醒目的"非官方"声明', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  assert.ok(result.dataNotes.some((n) => n.includes('演示') || n.includes('合成')));
  assert.equal(result.meta.store.demo, true);
});

test('求解参数：命令行覆盖项正确落到 targets 上', () => {
  const options = buildSolverOptions({ kcal: 900, protein: 45, sodium: 800, kcalTolerance: 0.1, minScore: 80, budgetYuan: 42 });
  assert.equal(options.targets.kcal, 900);
  assert.equal(options.targets.proteinG, 45);
  assert.equal(options.targets.sodiumMaxMg, 800);
  assert.equal(options.targets.kcalTolerance, 0.1);
  assert.equal(options.minScore, 80);
  assert.equal(options.budgetFen, 4200);

  const defaults = buildSolverOptions({});
  assert.equal(defaults.targets.kcal, 700);
  assert.equal(defaults.budgetFen, undefined);
});

test('选券：只挑门槛已满足且优惠最大的那张', () => {
  const coupons = [
    { id: 'C1', name: '满30减5', discountFen: 500, thresholdFen: 3000 },
    { id: 'C2', name: '满50减12', discountFen: 1200, thresholdFen: 5000 },
    { id: 'C3', name: '甜品减3', discountFen: 300, thresholdFen: 0 },
  ];
  assert.equal(pickBestCoupon(coupons, 3500).id, 'C1');
  assert.equal(pickBestCoupon(coupons, 6000).id, 'C2');
  assert.equal(pickBestCoupon(coupons, 2000).id, 'C3');
  assert.equal(pickBestCoupon([], 3000), null);
});

test('套餐拆解：能从嵌套结构里抽出组成项并按名称去重', () => {
  const menuItems = [{ name: '巨无霸', code: 'B1' }, { name: '薯条', code: 'F1' }, { name: '可口可乐', code: 'D1' }];
  const payload = {
    code: 0,
    data: {
      mealDetail: {
        name: '巨无霸三件套',
        comboItems: [
          { productName: '巨无霸' },
          { productName: '薯条' },
          { productName: '可口可乐' },
          { productName: '巨无霸' },
        ],
      },
    },
  };
  const parts = extractComboParts(payload, menuItems);
  const names = parts.map((p) => p.name);
  assert.ok(names.includes('巨无霸'));
  assert.ok(names.includes('薯条'));
  assert.equal(new Set(names).size, names.length, '组成项应当去重');
  assert.equal(parts.find((p) => p.name === '巨无霸').item.code, 'B1', '组成项应当对齐到菜单项');
});

test('演示数据集：品类齐全，价格与营养字段完整', () => {
  const dataset = demoDataset();
  const categories = new Set(dataset.menu.map((i) => i.category));
  for (const need of ['主食', '小食', '饮料', '甜品']) assert.ok(categories.has(need), `缺少品类 ${need}`);
  for (const item of dataset.menu) {
    assert.ok(item.priceFen > 0);
    assert.ok(item.code);
  }
  for (const row of dataset.nutrition) {
    assert.ok(row.energyKcal > 0);
    assert.ok(row.proteinG >= 0);
  }
});

test('菜单编码提取：从官方 query-meals 结构（categories + 顶层 meals）抽出编码清单', () => {
  const payload = {
    success: true,
    data: {
      categories: [
        { name: '人气热卖', meals: [{ code: '9900016076', tags: ['心形薯饼同款比心'] }, { code: '521954' }] },
        { name: '经典汉堡', meals: [{ code: '515946' }] },
      ],
      meals: [{ code: '9900016076' }], // 顶层平铺与分类重复，应去重
    },
  };
  const codes = extractMenuCodes(payload);
  assert.equal(codes.length, 3);
  assert.deepEqual(codes.map((c) => c.code).sort(), ['515946', '521954', '9900016076']);
  assert.equal(codes.find((c) => c.code === '9900016076').tags[0], '心形薯饼同款比心');
  assert.equal(codes.find((c) => c.code === '521954').cat, '人气热卖');
});

test('券去重：不同 id、相同名称的券合并成一张（否则「15 张可用券」是虚高的）', () => {
  const raw = [
    { id: 'A1', name: '麦旋风任选', couponPriceFen: 990, targetCodes: ['C1'], source: 'query-store-coupons' },
    { id: 'A2', name: '麦旋风任选', couponPriceFen: 990, appliesToCode: 'C1', source: 'query-my-coupons' },
    { id: 'A3', name: '麦旋风任选', couponPriceFen: 990, source: 'available-coupons' },
    { id: 'B1', name: '薯薯任选', couponPriceFen: 1200, source: 'query-my-coupons' },
  ];
  const merged = dedupeCoupons(raw);
  assert.equal(merged.length, 2, '同名券应合并，实测真实门店 15 条只有 8 个不同券名');
  const mcd = merged.find((c) => c.name === '麦旋风任选');
  assert.equal(mcd.couponPriceFen, 990);
  assert.equal(mcd.appliesToCode, 'C1', '合并后应保留任一视图才有的用券价适用商品');
  assert.deepEqual(mcd.targetCodes, ['C1']);
});

test('套餐拆解：只取 isDefault 默认选中的组成项，不把可选项也算进去', () => {
  const menu = [
    { name: '板烧鸡腿堡', code: 'B1', priceFen: 2000, category: '主食' },
    { name: '麦辣鸡腿堡', code: 'B2', priceFen: 2000, category: '主食' },
    { name: '薯条', code: 'F1', priceFen: 1000, category: '小食' },
    { name: '可乐', code: 'D1', priceFen: 900, category: '饮料' },
  ];
  const payload = {
    data: {
      name: '板烧三件套',
      choices: [
        { name: '主食', choices: [{ name: '板烧鸡腿堡', isDefault: 1 }, { name: '麦辣鸡腿堡', isDefault: 0 }] },
        { name: '小食', choices: [{ name: '薯条', isDefault: 1 }] },
        { name: '饮料', choices: [{ name: '可乐', isDefault: 1 }] },
      ],
    },
  };
  const names = extractComboParts(payload, menu).map((p) => p.name).sort();
  assert.deepEqual(names, ['可乐', '板烧鸡腿堡', '薯条'].sort());
  assert.ok(!names.includes('麦辣鸡腿堡'), '未选中的可选项不应被算作组成项');
});

test('套餐拆解：无 isDefault 标记时退回全部项，但超出常理的累加会被守卫拒绝', () => {
  const payload = { data: { items: [{ name: 'A' }, { name: 'B' }] } };
  assert.equal(extractComboParts(payload, []).length, 2);
  // 真实事故：四件套被累加成 7531 kcal / 蛋白 315 g（正常约 1000–1300 kcal）
  assert.equal(isPlausibleCombo({ energyKcal: 7531, proteinG: 315, sodiumMg: 15388 }), false);
  assert.equal(isPlausibleCombo({ energyKcal: 900, proteinG: 35, sodiumMg: 1800 }), true);
  assert.equal(isPlausibleCombo(null), false);
});
