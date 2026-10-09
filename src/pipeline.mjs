/**
 * 编排层：演示模式与实时模式共用同一条出口，产出渲染器需要的完整结果对象。
 * ---------------------------------------------------------------
 * 实时模式的取数顺序：
 *   now-time-info → query-nearby-stores → query-meals → list-nutrition-foods
 *   → query-store-coupons / available-coupons / query-my-coupons
 *   → （按需）query-meal-detail 拆解套餐营养 → 本地求解
 *   → calculate-price 对推荐方案做官方验价
 *
 * 全流程只读：不创建订单、不领券、不扣积分。
 */

import { normalizeCoupons, normalizeMenu, normalizeNutrition, normalizePrice, normalizeStores,
  matchNutrition, sanityCheckMenu, nameKey } from './normalize.mjs';
import { solve, DEFAULT_RULES, DEFAULT_TARGETS, DEFAULT_WEIGHTS, DEFAULT_MIN_SCORE } from './solver.mjs';
import { ToolRegistry, summarizeCalls, mapParams } from './tools.mjs';
import { demoDataset } from './demo-data.mjs';

const DEFAULT_SOLVER_OPTIONS = {
  targets: { ...DEFAULT_TARGETS },
  rules: { ...DEFAULT_RULES },
  weights: { ...DEFAULT_WEIGHTS },
  minScore: DEFAULT_MIN_SCORE,
  perCategory: 8,
};

/** 把用户选项合并成求解参数 */
export function buildSolverOptions(options = {}) {
  const targets = {
    ...DEFAULT_TARGETS,
    ...(options.kcal !== undefined ? { kcal: Number(options.kcal) } : {}),
    ...(options.protein !== undefined ? { proteinG: Number(options.protein) } : {}),
    ...(options.sodium !== undefined ? { sodiumMaxMg: Number(options.sodium) } : {}),
    ...(options.kcalTolerance !== undefined ? { kcalTolerance: Number(options.kcalTolerance) } : {}),
  };
  return {
    ...DEFAULT_SOLVER_OPTIONS,
    targets,
    minScore: options.minScore !== undefined ? Number(options.minScore) : DEFAULT_MIN_SCORE,
    perCategory: options.perCategory !== undefined ? Number(options.perCategory) : 8,
    budgetFen: options.budgetYuan !== undefined ? Math.round(Number(options.budgetYuan) * 100) : undefined,
  };
}

/** 演示模式：完全离线，数据来自 demo-data.mjs，产物显著标注"演示数据" */
export function buildPlanDemo(options = {}) {
  const dataset = demoDataset();
  const solverOptions = buildSolverOptions(options);
  const budgetFen = solverOptions.budgetFen ?? 3000;

  const nutritionByItem = matchNutrition(dataset.menu, dataset.nutrition);
  const result = solve({
    items: dataset.menu,
    nutritionByItem,
    targets: solverOptions.targets,
    budgetFen,
    rules: solverOptions.rules,
    weights: solverOptions.weights,
    minScore: solverOptions.minScore,
    perCategory: solverOptions.perCategory,
  });

  const matched = [...nutritionByItem.values()].filter((v) => v.nutrition).length;

  return {
    meta: {
      mode: 'demo',
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      store: dataset.store,
      endpoint: '离线演示（未连接 MCP）',
      toolsUsed: [],
    },
    targets: solverOptions.targets,
    budgetFen,
    ...result,
    coverage: {
      menuTotal: dataset.menu.length,
      matched,
      unmatched: dataset.menu.length - matched,
    },
    coupons: dataset.coupons,
    dataNotes: dataset.warnings,
    priceVerification: null,
  };
}

/**
 * 实时模式：连接官方 MCP 取真实数据。
 * 任何一步失败都会抛出带可操作提示的错误，而不是"悄悄降级成假数据"。
 */
export async function buildPlanLive(registry, options = {}) {
  const solverOptions = buildSolverOptions(options);
  const toolsUsed = [];
  const dataNotes = [];
  const warnings = [];

  // 1) 服务器时间（用于判断活动/券有效期，避免用本地时区猜）
  let serverTime = null;
  if (registry.has('now-time-info')) {
    try {
      const res = await registry.call('now-time-info', {});
      toolsUsed.push('now-time-info');
      serverTime = res.data ?? null;
    } catch (err) {
      warnings.push(`获取服务器时间失败：${err.message}`);
    }
  }

  // 2) 门店
  const storeTool = registry.schema('query-nearby-stores');
  if (!storeTool) throw new Error('当前 MCP 服务未暴露 query-nearby-stores，无法定位门店。');

  const storeParams = mapParams(storeTool, [
    { keys: ['searchType'], value: options.searchType ?? 2 },
    { keys: ['cityName', 'city', 'cityCode'], value: options.city },
    { keys: ['keyword', 'storeName', 'storeKeyword', 'searchKey', 'address'], value: options.storeKeyword },
    { keys: ['beType'], value: options.beType ?? 1 },
    { keys: ['longitude', 'lng'], value: options.lng },
    { keys: ['latitude', 'lat'], value: options.lat },
  ]);
  if (storeParams.unmatched.length) {
    dataNotes.push(`门店查询有未匹配参数：${storeParams.unmatched.join('、')}（官方工具可能已改名，已自动跳过）。`);
  }

  const storeRes = await registry.call('query-nearby-stores', storeParams.args);
  toolsUsed.push('query-nearby-stores');
  const stores = normalizeStores(storeRes.data ?? storeRes.raw);
  if (stores.length === 0) {
    throw new Error('未查询到门店。请用 --city 指定城市、--store 指定门店名或地标后重试。');
  }
  const store = options.storeCode
    ? stores.find((s) => s.code === String(options.storeCode)) ?? stores[0]
    : stores[0];
  if (!store.code) throw new Error('门店返回中缺少门店编码，无法继续查询菜单。');

  // 3) 菜单
  const menuTool = registry.schema('query-meals');
  if (!menuTool) throw new Error('当前 MCP 服务未暴露 query-meals，无法获取菜单。');
  const menuParams = mapParams(menuTool, [
    { keys: ['beCode', 'storeCode', 'storeId', 'code'], value: store.code },
    { keys: ['beType'], value: options.beType ?? 1 },
  ]);
  const menuRes = await registry.call('query-meals', menuParams.args);
  toolsUsed.push('query-meals');
  const { items: menuItems, rawCount } = normalizeMenu(menuRes.data ?? menuRes.raw);
  if (menuItems.length === 0) {
    throw new Error('菜单为空：可能是门店编码或取餐方式（beType）不匹配，请核对后重试。');
  }

  // 4) 营养库
  const nutritionRes = await registry.call('list-nutrition-foods', {});
  toolsUsed.push('list-nutrition-foods');
  const nutritionRows = normalizeNutrition(nutritionRes.data ?? nutritionRes.raw);

  let nutritionByItem = matchNutrition(menuItems, nutritionRows);
  let matched = [...nutritionByItem.values()].filter((v) => v.nutrition).length;

  // 5) 套餐拆解：匹配不上的项尝试用 query-meal-detail 拿组成，再逐项累加营养
  const comboBudget = options.comboLookupLimit ?? 12;
  const unresolved = menuItems.filter((item) => !nutritionByItem.get(item)?.nutrition);
  let comboResolved = 0;
  if (registry.has('query-meal-detail') && unresolved.length && comboBudget > 0) {
    const detailTool = registry.schema('query-meal-detail');
    for (const item of unresolved.slice(0, comboBudget)) {
      if (!item.code) continue;
      try {
        const detailParams = mapParams(detailTool, [
          { keys: ['code', 'productCode', 'mealCode', 'skuCode'], value: item.code },
          { keys: ['beCode', 'storeCode', 'storeId'], value: store.code },
          { keys: ['beType'], value: options.beType ?? 1 },
        ]);
        const detailRes = await registry.call('query-meal-detail', detailParams.args);
        const parts = extractComboParts(detailRes.data ?? detailRes.raw, menuItems);
        if (parts.length >= 2) {
          const summed = sumPartsNutrition(parts, nutritionByItem);
          if (summed) {
            nutritionByItem.set(item, {
              nutrition: summed,
              matchType: 'combo',
              matchedName: parts.map((p) => p.name).join(' + '),
            });
            comboResolved += 1;
            matched += 1;
          }
        }
      } catch {
        // 单个套餐拆解失败不影响整体，继续
      }
    }
    if (comboResolved > 0) {
      toolsUsed.push('query-meal-detail');
      dataNotes.push(`通过 query-meal-detail 拆解并累加营养的套餐：${comboResolved} 个（营养值为组成项之和）。`);
    }
  }

  const matchStats = summarizeMatch(nutritionByItem, menuItems);

  // 6) 优惠券（只读：不领券）
  const coupons = [];
  const couponSources = [
    ['query-store-coupons', [{ keys: ['beCode', 'storeCode', 'storeId', 'code'], value: store.code },
      { keys: ['beType'], value: options.beType ?? 1 }]],
    ['available-coupons', []],
    ['query-my-coupons', []],
  ];
  for (const [toolName, groups] of couponSources) {
    if (!registry.has(toolName)) continue;
    try {
      const tool = registry.schema(toolName);
      const params = groups.length ? mapParams(tool, groups) : { args: {} };
      const res = await registry.call(toolName, params.args);
      toolsUsed.push(toolName);
      coupons.push(...normalizeCoupons(res.data ?? res.raw).map((c) => ({ ...c, source: toolName })));
    } catch (err) {
      warnings.push(`查询优惠券 ${toolName} 失败：${err.message}`);
    }
  }
  const uniqCoupons = [...new Map(coupons.map((c) => [c.id, c])).values()];

  // 7) 求解
  const budgetFen = solverOptions.budgetFen
    ?? (options.budgetYuan !== undefined ? Math.round(Number(options.budgetYuan) * 100) : undefined);
  if (budgetFen === undefined) throw new Error('实时模式必须给出预算，例如 --budget 30。');

  const result = solve({
    items: menuItems,
    nutritionByItem,
    targets: solverOptions.targets,
    budgetFen,
    rules: solverOptions.rules,
    weights: solverOptions.weights,
    minScore: solverOptions.minScore,
    perCategory: solverOptions.perCategory,
  });

  // 8) 官方验价（只对推荐方案调用，控制请求量）
  let priceVerification = null;
  if (options.verify !== false && registry.has('calculate-price') && result.recommendations.length) {
    priceVerification = { verified: [], failures: [] };
    const KIND_LABELS = { valueBest: '双赢推荐', topScore: '营养上限', cheapest: '省钱底线' };
    for (let i = 0; i < result.recommendations.length; i += 1) {
      const plan = result.recommendations[i];
      const label = KIND_LABELS[plan.kind] ?? `方案 ${String.fromCharCode(65 + i)}`;
      try {
        const tool = registry.schema('calculate-price');
        const couponId = pickBestCoupon(uniqCoupons, plan.totals.priceFen);
        const groups = [
          { keys: ['beCode', 'storeCode', 'storeId', 'code'], value: store.code },
          { keys: ['beType'], value: options.beType ?? 1 },
          { keys: ['products', 'meals', 'items', 'productList', 'cart'], value: plan.items.map((item) => ({ code: item.code, quantity: 1 })) },
          { keys: ['couponIds', 'couponId', 'coupons'], value: couponId ? [couponId.id] : undefined },
        ];
        const params = mapParams(tool, groups);
        const res = await registry.call('calculate-price', params.args);
        toolsUsed.push('calculate-price');
        const priced = normalizePrice(res.data ?? res.raw);
        priceVerification.verified.push({
          index: i,
          label,
          localFen: plan.totals.priceFen,
          officialFen: priced?.totalFen ?? null,
          discountFen: priced?.discountFen ?? null,
          couponName: couponId?.name ?? null,
        });
      } catch (err) {
        priceVerification.failures.push({ index: i, label, reason: err.message });
      }
    }
    if (priceVerification.verified.some((v) => v.officialFen !== null)) {
      dataNotes.push('官方算价（calculate-price）结果已用于核验本地菜单价合计；与本地不一致时请以官方返回为准。');
    }
  }

  // 9) 汇总口径说明
  const sanity = sanityCheckMenu(menuItems);
  dataNotes.push(`菜单原始条目 ${rawCount} 条，去重后 ${menuItems.length} 项参与计算。`);
  if (matchStats.unmatched > 0) {
    dataNotes.push(`有 ${matchStats.unmatched} 项餐品未匹配到官方营养数据，已排除在优化之外（不使用猜测值）。`);
  }
  if (uniqCoupons.length > 0) {
    dataNotes.push(`发现 ${uniqCoupons.length} 张可用优惠券，仅用于估算优惠后金额；本项目不会自动领券。`);
  } else {
    dataNotes.push('本次未查询到可用优惠券，金额为未用券口径。');
  }
  dataNotes.push(...sanity, ...warnings);

  return {
    meta: {
      mode: 'live',
      generatedAt: serverTime ? String(typeof serverTime === 'string' ? serverTime : JSON.stringify(serverTime)).slice(0, 60)
        : new Date().toISOString().replace('T', ' ').slice(0, 19),
      store,
      endpoint: options.endpoint ?? 'https://mcp.mcd.cn',
      toolsUsed: [...new Set(toolsUsed)],
      callStats: summarizeCalls(registry.callLog),
    },
    targets: solverOptions.targets,
    budgetFen,
    ...result,
    coverage: {
      menuTotal: menuItems.length,
      matched: matchStats.matched,
      unmatched: matchStats.unmatched,
      byMatchType: matchStats.byMatchType,
    },
    coupons: uniqCoupons,
    dataNotes,
    priceVerification,
  };
}

// ---------------------------------------------------------------- 辅助

function summarizeMatch(nutritionByItem, menuItems) {
  const byMatchType = {};
  let matched = 0;
  for (const item of menuItems) {
    const entry = nutritionByItem.get(item);
    const type = entry?.nutrition ? entry.matchType : 'none';
    byMatchType[type] = (byMatchType[type] ?? 0) + 1;
    if (entry?.nutrition) matched += 1;
  }
  return { matched, unmatched: menuItems.length - matched, byMatchType };
}

/** 从套餐详情里抽出组成项（尽量按名称对齐菜单项，拿不到就只留名称） */
export function extractComboParts(payload, menuItems) {
  const found = [];
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1));
      return;
    }
    const name = node.name ?? node.productName ?? node.mealName ?? node.itemName;
    if (typeof name === 'string' && name.trim()) {
      const key = nameKey(name);
      const hit = menuItems.find((m) => nameKey(m.name) === key)
        ?? menuItems.find((m) => nameKey(m.name).includes(key) || key.includes(nameKey(m.name)));
      found.push({ name: name.trim(), item: hit ?? null });
    }
    Object.values(node).forEach((v) => visit(v, depth + 1));
  };
  visit(payload);
  // 去掉与套餐本身同名的项，并按名称去重
  const uniq = new Map();
  for (const part of found) {
    const key = nameKey(part.name);
    if (!key || !uniq.has(key)) uniq.set(key, part);
  }
  return [...uniq.values()];
}

/** 累加套餐组成项的营养 */
function sumPartsNutrition(parts, nutritionByItem) {
  const acc = { energyKcal: 0, proteinG: 0, fatG: 0, carbG: 0, sodiumMg: 0, calciumMg: 0, inferred: ['套餐营养按组成项累加'] };
  let counted = 0;
  for (const part of parts) {
    const entry = part.item ? nutritionByItem.get(part.item) : null;
    const nutrition = entry?.nutrition;
    if (!nutrition) continue;
    counted += 1;
    for (const field of ['energyKcal', 'proteinG', 'fatG', 'carbG', 'sodiumMg', 'calciumMg']) {
      if (typeof nutrition[field] === 'number') acc[field] += nutrition[field];
    }
  }
  if (counted < 2) return null;
  for (const field of ['energyKcal', 'proteinG', 'fatG', 'carbG', 'sodiumMg']) {
    acc[field] = Math.round(acc[field] * 10) / 10;
  }
  acc.calciumMg = Math.round(acc.calciumMg);
  return acc;
}

/** 选一张门槛已满足、优惠最大的券（仅用于估算，不领券） */
export function pickBestCoupon(coupons, priceFen) {
  const usable = coupons.filter((c) => (c.thresholdFen ?? 0) <= priceFen && (c.discountFen ?? 0) > 0);
  if (usable.length === 0) return null;
  return usable.sort((a, b) => b.discountFen - a.discountFen)[0];
}
