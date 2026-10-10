import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fenToYuan, yuanToFen, formatYuan, toNumber, nameKey, inferCategory,
  extractNutrition, normalizeMenu, normalizeNutrition, parseToonTable, matchNutrition,
  normalizeCoupons, mergeCoupon, normalizePrice, normalizeStores, sanityCheckMenu,
} from '../src/normalize.mjs';

test('金额换算：分 ↔ 元，格式化固定两位小数', () => {
  assert.equal(fenToYuan(2150), 21.5);
  assert.equal(yuanToFen(21.5), 2150);
  assert.equal(formatYuan(2150), '21.50');
  assert.equal(formatYuan(2150, { withSymbol: true }), '¥21.50');
  assert.equal(formatYuan(null), '—');
  assert.equal(fenToYuan(0), 0);
});

test('数字容错：能吃下货币符号、千分位与中文单位', () => {
  assert.equal(toNumber('¥12.5元'), 12.5);
  assert.equal(toNumber('1,234'), 1234);
  assert.equal(toNumber('  88 '), 88);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(0), 0);
});

test('名称规范化：去掉规格词、括号内容与标点，用于跨工具匹配', () => {
  assert.equal(nameKey('巨无霸（中杯）'), '巨无霸');
  assert.equal(nameKey('薯条 大份'), '薯条');
  assert.equal(nameKey('麦乐鸡（5块）'), '麦乐鸡');
  assert.equal(nameKey('可口可乐·中杯'), '可口可乐');
});

test('品类推断：接口给了就用接口的，没给才按名称推断并标记 inferred', () => {
  assert.deepEqual(inferCategory('巨无霸', '主食'), { category: '主食', inferred: false });
  assert.deepEqual(inferCategory('可口可乐（中）'), { category: '饮料', inferred: true });
  assert.deepEqual(inferCategory('圆筒冰淇淋'), { category: '甜品', inferred: true });
  assert.deepEqual(inferCategory('未知神秘餐品'), { category: '其他', inferred: true });
});

test('品类推断：主食的形态强特征优先于小食的配料词（否则汉堡会被判成小食）', () => {
  // 「板烧鸡腿堡」含小食关键字「鸡腿」，但它是主食。顺序写反会把一批汉堡归进小食，
  // 而小食上限是 2 —— 等于允许一份方案里塞进 3 个汉堡。真实门店曾错分 13 个。
  assert.equal(inferCategory('板烧鸡腿堡').category, '主食');
  assert.equal(inferCategory('麦辣鸡腿堡四件套').category, '主食');
  assert.equal(inferCategory('龙焰芝士棒鸡腿堡').category, '主食');
  // 新增的主食名（原来落到「其他」而被永久排除）
  assert.equal(inferCategory('麦香鱼').category, '主食');
  assert.equal(inferCategory('麦香鸡').category, '主食');
  // 真正的小食仍留在小食（去掉裸「麦辣」后不再被主食提前拦下）
  assert.equal(inferCategory('麦辣鸡翅4块中套餐').category, '小食');
  assert.equal(inferCategory('麦乐鸡经典中套餐').category, '小食');
  assert.equal(inferCategory('薄皮焦香V翅').category, '小食');
  // 补全的甜品 / 饮料关键字
  assert.equal(inferCategory('灰焰圆筒').category, '甜品');
  assert.equal(inferCategory('美禄可可雪冰').category, '饮料');
  assert.equal(inferCategory('学生专享饮品随心选').category, '饮料');
});

test('营养单位推断：kJ 自动换算成 kcal，钠 g 自动换算成 mg，并留下推断痕迹', () => {
  const kj = extractNutrition({ name: 'X', energy: 2000, protein: 10 });
  assert.equal(Math.round(kj.energyKcal), 478);
  assert.ok(kj.inferred.some((s) => s.includes('kJ')));

  const sodiumInGram = extractNutrition({ name: 'X', energyKcal: 100, sodium: 1.2 });
  assert.equal(sodiumInGram.sodiumMg, 1200);
  assert.ok(sodiumInGram.inferred.some((s) => s.includes('g→mg')));

  const explicitKcal = extractNutrition({ name: 'X', energyKcal: 550, protein: 26 });
  assert.equal(explicitKcal.energyKcal, 550);
  assert.equal(explicitKcal.inferred.length, 0);
});

test('菜单归一化：容错字段名、同名取更便宜的一条', () => {
  const payload = {
    code: 0,
    data: {
      meals: [
        { name: '巨无霸', price: 2150, code: 'B1', categoryName: '主食' },
        { name: '巨无霸', price: 2050, code: 'B2', categoryName: '主食' },
        { productName: '可口可乐', unitPrice: 950, productCode: 'D1' },
      ],
    },
  };
  const { items } = normalizeMenu(payload);
  assert.equal(items.length, 2);
  const bigmac = items.find((i) => i.name === '巨无霸');
  assert.equal(bigmac.priceFen, 2050);
  assert.equal(bigmac.code, 'B2');
  assert.equal(bigmac.category, '主食');
  const coke = items.find((i) => i.name === '可口可乐');
  assert.equal(coke.priceFen, 950);
  assert.equal(coke.category, '饮料');
});

test('营养归一化：支持数组与映射表两种形态', () => {
  const fromArray = normalizeNutrition({ list: [{ name: '巨无霸', energyKcal: 550, protein: 26, sodium: 1050 }] });
  assert.equal(fromArray.length, 1);
  assert.equal(fromArray[0].proteinG, 26);

  const fromMap = normalizeNutrition({ 巨无霸: { energy: 550, protein: 26 } });
  assert.equal(fromMap.length, 1);
  assert.equal(fromMap[0].name, '巨无霸');
});

test('营养归一化：解析官方 toon 紧凑格式（真实返回样例）', () => {
  const toon = '[2]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n'
    + '  猪柳麦满分,null,1288,308,16,16,24,781,213\n'
    + '  巨无霸,null,2146,513,27,26,42,961,171';
  const rows = parseToonTable(toon);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].productName, '猪柳麦满分');
  assert.equal(rows[0].energyKj, '1288');
  assert.equal(rows[1].energyKcal, '513');

  // 字符串直传与 {data: "toon"} 包装都支持；energyKcal 字段命中 kcal 别名，不做 kJ 换算
  const direct = normalizeNutrition(toon);
  assert.equal(direct.length, 2);
  assert.equal(direct[1].energyKcal, 513);
  assert.equal(direct[1].proteinG, 27);
  assert.equal(direct[1].sodiumMg, 961);

  const wrapped = normalizeNutrition({ success: true, code: 200, data: toon });
  assert.equal(wrapped.length, 2);
  assert.equal(wrapped[0].energyKcal, 308);
});

test('营养匹配：精确 / 包含 / 未命中 三种结果都可追溯', () => {
  const menu = [
    { name: '巨无霸', priceFen: 2150, code: 'B1' },
    { name: '薯条（中）', priceFen: 1300, code: 'F1' },
    { name: '巨无霸三件套', priceFen: 3350, code: 'C1' },
    { name: '神秘新品', priceFen: 999, code: 'X1' },
  ];
  const nutrition = [
    { name: '巨无霸', key: '巨无霸', energyKcal: 550, proteinG: 26 },
    { name: '薯条', key: '薯条', energyKcal: 340, proteinG: 4 },
  ];
  const result = matchNutrition(menu, nutrition);
  // 规格词被规范化掉，"薯条（中）"可以对上"薯条"，属于精确匹配
  assert.equal(result.get(menu[0]).matchType, 'exact');
  assert.equal(result.get(menu[1]).matchType, 'exact');
  assert.equal(result.get(menu[1]).nutrition.proteinG, 4);
  // 套餐名包含单品名，走包含匹配
  assert.equal(result.get(menu[2]).matchType, 'contains');
  assert.equal(result.get(menu[2]).nutrition.proteinG, 26);
  assert.equal(result.get(menu[3]).nutrition, null);
  assert.equal(result.get(menu[3]).matchType, 'none');
});

test('优惠券归一化：保留面额、门槛与来源', () => {
  const coupons = normalizeCoupons({
    data: { coupons: [{ couponId: 'C1', name: '满30减5', discountAmount: 500, threshold: 3000 }] },
  });
  assert.equal(coupons.length, 1);
  assert.equal(coupons[0].id, 'C1');
  assert.equal(coupons[0].discountFen, 500);
  assert.equal(coupons[0].thresholdFen, 3000);
});

test('算价归一化：字段被包在未知层级里也能取到总价', () => {
  const flat = normalizePrice({ totalAmount: 2550, discountAmount: 500, originalAmount: 3050 });
  assert.equal(flat.totalFen, 2550);
  assert.equal(flat.discountFen, 500);

  const wrapped = normalizePrice({ code: 0, data: { priceInfo: { total_amount: 2380, discount_amount: 300 } } });
  assert.equal(wrapped.totalFen, 2380);
  assert.equal(wrapped.discountFen, 300);

  assert.equal(normalizePrice({ code: 0, msg: 'ok' }).totalFen, null);
  assert.equal(normalizePrice(null), null);
});

test('门店归一化：按门店编码去重', () => {
  const stores = normalizeStores({
    data: { stores: [{ beCode: 'S1', storeName: '测试餐厅', address: '某某路 1 号' }, { beCode: 'S1', storeName: '测试餐厅' }] },
  });
  assert.equal(stores.length, 1);
  assert.equal(stores[0].code, 'S1');
});

test('菜单体检：价格单位可疑或缺编码时给出警告', () => {
  const warnings = sanityCheckMenu([
    { name: 'A', priceFen: 20, code: null },
    { name: 'B', priceFen: 30, code: null },
  ]);
  assert.ok(warnings.some((w) => w.includes('分')));
  assert.ok(warnings.some((w) => w.includes('商品编码')));
});

test('优惠券归一化：解析商品级用券价与适用商品，并按 id 合并门店券与卡包券两份视图', () => {
  // 门店券视图：带适用商品编码
  const fromStore = normalizeCoupons({
    data: [{ couponId: 'W1', title: '麦旋风任选', promotionId: 'P1',
      products: [{ productCode: '9900014239', productName: '麦旋风任选1' }] }],
  });
  // 卡包券视图：带用券价与取餐方式
  const fromWallet = normalizeCoupons({
    data: { coupons: [{ id: 'W1', title: '麦旋风任选', promotionId: 'P1', orderTypes: [1], beTypes: [1, 5],
      discountInfo: { discountValue: '9.9', discountDesc: '用券价格', discountTypeText: '¥' } }] },
  });
  assert.equal(fromStore[0].targetCodes[0], '9900014239');
  assert.equal(fromWallet[0].couponPriceFen, 990);
  assert.deepEqual(fromWallet[0].beTypes, [1, 5]);
  assert.equal(fromWallet[0].discountFen, null, '用券价券不应被误读成订单满减');

  const merged = mergeCoupon(fromStore[0], fromWallet[0]);
  assert.equal(merged.name, '麦旋风任选');
  assert.equal(merged.couponPriceFen, 990);
  assert.equal(merged.targetCodes[0], '9900014239');
  assert.deepEqual(merged.beTypes, [1, 5]);

  // 面额型券（第二份半价）：只记录面额，不当作减免
  const face = normalizeCoupons({
    data: { coupons: [{ id: 'F1', title: '灰焰圆筒第二份半价', denomination: 750, isPrepaid: 1 }] },
  });
  assert.equal(face[0].faceValueFen, 750);
  assert.equal(face[0].couponPriceFen, null);
  assert.equal(face[0].discountFen, null);
});
