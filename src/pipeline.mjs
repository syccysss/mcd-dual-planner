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

import { normalizeCoupons, normalizeNutrition, normalizePrice, normalizeStores,
  matchNutrition, sanityCheckMenu, nameKey, inferCategory, mergeCoupon } from './normalize.mjs';
import { cacheLoad, cacheSave } from './cache.mjs';
import { solve, pickBestCoupon, DEFAULT_RULES, DEFAULT_TARGETS, DEFAULT_WEIGHTS, DEFAULT_MIN_SCORE,
  DEFAULT_PER_CATEGORY } from './solver.mjs';
import { ToolRegistry, summarizeCalls, mapParams } from './tools.mjs';
import { demoDataset } from './demo-data.mjs';

const DEFAULT_SOLVER_OPTIONS = {
  targets: { ...DEFAULT_TARGETS },
  rules: { ...DEFAULT_RULES },
  weights: { ...DEFAULT_WEIGHTS },
  minScore: DEFAULT_MIN_SCORE,
  perCategory: DEFAULT_PER_CATEGORY,
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
    perCategory: options.perCategory !== undefined ? Number(options.perCategory) : DEFAULT_PER_CATEGORY,
    budgetFen: options.budgetYuan !== undefined ? Math.round(Number(options.budgetYuan) * 100) : undefined,
  };
}

/** 演示模式：完全离线，数据来自 demo-data.mjs，产物显著标注"演示数据" */
export function buildPlanDemo(options = {}) {
  const dataset = demoDataset();
  const solverOptions = buildSolverOptions(options);
  const budgetFen = solverOptions.budgetFen ?? 3000;

  const nutritionByItem = matchNutrition(dataset.menu, dataset.nutrition);
  // 演示券都是订单级满减、可直接量化，标记 usable；与实时模式的券结构保持一致
  const demoCoupons = dataset.coupons.map((c) => ({ ...c, usable: true, excludedReason: null }));
  const result = solve({
    items: dataset.menu,
    nutritionByItem,
    targets: solverOptions.targets,
    budgetFen,
    rules: solverOptions.rules,
    weights: solverOptions.weights,
    minScore: solverOptions.minScore,
    perCategory: solverOptions.perCategory,
    coupons: demoCoupons,
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
    coupons: demoCoupons,
    dataNotes: [
      ...dataset.warnings,
      '口径：预算卡券前菜单价，结论按券后实付排序（三个结论重合时去重，可能只输出 1~2 条）；演示券为订单级满减（真实官方券多为「指定商品用券价」）。',
    ],
    priceVerification: null,
  };
}

/**
 * 券去重：同一张券会在门店券 / 卡包券里以「不同 id、相同名称」重复出现
 * （实测真实门店 15 条里只有 8 个不同券名），因此同时按 id 与名称建索引，
 * 任一命中即合并 —— 否则报出去的「15 张可用券」是虚高的。
 */
export function dedupeCoupons(coupons) {
  const byId = new Map();
  const byName = new Map();
  const out = [];
  for (const c of coupons) {
    const nk = nameKey(c.name ?? '');
    const existing = byId.get(c.id) ?? (nk ? byName.get(nk) : undefined);
    if (existing) {
      const merged = mergeCoupon(existing, c);
      const at = out.indexOf(existing);
      if (at >= 0) out[at] = merged; else out.push(merged);
      byId.set(c.id, merged);
      if (existing.id && existing.id !== c.id) byId.set(existing.id, merged);
      if (nk) byName.set(nk, merged);
    } else {
      out.push(c);
      byId.set(c.id, c);
      if (nk) byName.set(nk, c);
    }
  }
  return out;
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

  // 3) 菜单编码清单：官方 query-meals 只返回商品编码与标签，名称与价格需逐品调用官方算价
  //    两步整体可走本地缓存（TTL 内复用，二次求解从 140 次请求降到个位数）
  const cacheParams = { storeCode: store.code, beType: options.beType ?? 1, orderType: options.orderType ?? 1 };
  let menuItems = null;
  let pricingFailed = 0;
  if (options.cache !== false) {
    const hit = await cacheLoad(cacheParams, { ttlMs: options.cacheTtlMs ?? 30 * 60 * 1000 });
    if (hit) {
      menuItems = hit.menu;
      pricingFailed = hit.pricingFailed;
      const when = new Date(hit.savedAt).toLocaleString('zh-CN', { hour12: false });
      dataNotes.push(`菜单复用本地缓存（${when} 抓取，TTL 内未消耗额外请求；--no-cache 可强制刷新）。`);
    }
  }

  if (!menuItems) {
    const menuTool = registry.schema('query-meals');
    if (!menuTool) throw new Error('当前 MCP 服务未暴露 query-meals，无法获取菜单。');
    const menuParams = mapParams(menuTool, [
      { keys: ['storeCode', 'storeId', 'beCode', 'code'], value: store.code },
      { keys: ['beType'], value: options.beType ?? 1 },
      { keys: ['orderType'], value: options.orderType ?? 1 },
    ]);
    const menuRes = await registry.call('query-meals', menuParams.args);
    toolsUsed.push('query-meals');
    const menuEntries = extractMenuCodes(menuRes.data ?? menuRes.raw);
    if (menuEntries.length === 0) {
      throw new Error('菜单为空：可能是门店编码或取餐方式（beType）不匹配，请核对后重试。');
    }

    // 4) 逐品算价：官方 calculate-price 一次返回 productName 与单价，同时补齐名称与价格
    const priceTool = registry.schema('calculate-price');
    if (!priceTool) throw new Error('当前 MCP 服务未暴露 calculate-price，无法获取餐品名称与价格。');
    menuItems = [];
    for (const entry of menuEntries) {
      try {
        const priceGroups = [
          { keys: ['storeCode', 'storeId', 'beCode', 'code'], value: store.code },
          { keys: ['beType'], value: options.beType ?? 1 },
          { keys: ['orderType'], value: options.orderType ?? 1 },
          { keys: ['products', 'meals', 'items', 'productList', 'cart'], value: [{ productCode: entry.code, quantity: 1 }] },
        ];
        const priceParams = mapParams(priceTool, priceGroups);
        const priceRes = await registry.call('calculate-price', priceParams.args);
        const priced = normalizePrice(priceRes.data ?? priceRes.raw);
        const line = priced?.lines?.[0];
        if (line && priced.totalFen !== null) {
          const { category, inferred } = inferCategory(line.name);
          menuItems.push({
            code: entry.code,
            name: line.name,
            priceFen: priced.totalFen,
            priceSource: 'official-calculate-price',
            category,
            categoryInferred: inferred,
            rawCategory: entry.cat ?? null,
            tags: entry.tags ?? [],
          });
        } else {
          pricingFailed += 1;
        }
      } catch {
        pricingFailed += 1; // 单品售罄/不可售（官方错误码 60006）或网络抖动：跳过该品，不影响整体
      }
    }
    toolsUsed.push('calculate-price');
    if (menuItems.length === 0) {
      throw new Error('菜单中所有商品都无法取得官方算价，请换一家门店或调整取餐方式后重试。');
    }
    if (options.cache !== false) {
      await cacheSave(cacheParams, { menu: menuItems, pricingFailed }).catch(() => {});
    }
  }
  dataNotes.push(`菜单 ${menuItems.length} 项参与计算（名称与单价均来自官方算价 calculate-price）${pricingFailed > 0 ? `；${pricingFailed} 个售罄/不可售已跳过` : ''}。`);

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
  let comboRejected = 0;
  if (registry.has('query-meal-detail') && unresolved.length && comboBudget > 0) {
    const detailTool = registry.schema('query-meal-detail');
    for (const item of unresolved.slice(0, comboBudget)) {
      if (!item.code) continue;
      try {
        const detailParams = mapParams(detailTool, [
          { keys: ['code', 'productCode', 'mealCode', 'skuCode'], value: item.code },
          { keys: ['storeCode', 'storeId', 'beCode'], value: store.code },
          { keys: ['beType'], value: options.beType ?? 1 },
          { keys: ['orderType'], value: options.orderType ?? 1 },
        ]);
        const detailRes = await registry.call('query-meal-detail', detailParams.args);
        const parts = extractComboParts(detailRes.data ?? detailRes.raw, menuItems);
        if (parts.length >= 2) {
          const summed = sumPartsNutrition(parts, nutritionByItem);
          if (summed && isPlausibleCombo(summed)) {
            nutritionByItem.set(item, {
              nutrition: summed,
              matchType: 'combo',
              matchedName: parts.map((p) => p.name).join(' + '),
            });
            comboResolved += 1;
            matched += 1;
          } else if (summed) {
            // 累加结果不合常理（多半是把"可选"的每一项都算进去了）：丢弃，宁可当未知
            comboRejected += 1;
          }
        }
      } catch {
        // 单个套餐拆解失败不影响整体，继续
      }
    }
    if (comboResolved > 0 || comboRejected > 0) toolsUsed.push('query-meal-detail');
    if (comboResolved > 0) {
      dataNotes.push(`通过 query-meal-detail 拆解并累加营养的套餐：${comboResolved} 个（只取 isDefault 默认组成项）。`);
    }
    if (comboRejected > 0) {
      dataNotes.push(`有 ${comboRejected} 个套餐的组成项累加结果超出常理（>${COMBO_PLAUSIBLE_LIMITS.energyKcal} kcal），已按"营养未知"处理而不是拿错数硬算。`);
    }
  }

  const matchStats = summarizeMatch(nutritionByItem, menuItems);

  // 6) 优惠券（只读：不领券）
  const coupons = [];
  const couponSources = [
    ['query-store-coupons', [{ keys: ['storeCode', 'storeId', 'beCode', 'code'], value: store.code },
      { keys: ['beType'], value: options.beType ?? 1 },
      { keys: ['orderType'], value: options.orderType ?? 1 }]],
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
  // 同一张券会在门店券/卡包券里以「不同 id、相同名称」重复出现，按 id 与名称双键合并去重
  const uniqCoupons = dedupeCoupons(coupons);

  // 6.1) 券落到具体商品：官方券是「商品级用券价」，必须定位到方案里确实包含的商品才算数；
  //      同时按当前取餐方式（beType / orderType）过滤掉用不了的券。
  const beType = options.beType ?? 1;
  const orderType = options.orderType ?? 1;
  const menuCodeSet = new Set(menuItems.map((m) => String(m.code)));
  const usableCoupons = [];
  let unusableCoupon = 0;
  let unquantifiedCoupon = 0;
  for (const coupon of uniqCoupons) {
    coupon.usable = false;
    coupon.excludedReason = null;

    if (coupon.beTypes?.length && !coupon.beTypes.includes(beType)) {
      coupon.excludedReason = '与当前取餐方式（beType）不匹配';
      unusableCoupon += 1;
      continue;
    }
    if (coupon.orderTypes?.length && !coupon.orderTypes.includes(orderType)) {
      coupon.excludedReason = '与当前订单类型（orderType）不匹配';
      unusableCoupon += 1;
      continue;
    }

    if ((coupon.couponPriceFen ?? 0) > 0) {
      // 适用商品：先用官方商品编码，拿不到再按名称匹配菜单（三态匹配的保守版）
      let code = (coupon.targetCodes ?? []).find((c) => menuCodeSet.has(String(c))) ?? null;
      if (!code) {
        const key = nameKey(coupon.name);
        const hit = key
          ? menuItems.find((m) => nameKey(m.name) === key)
            ?? menuItems.find((m) => nameKey(m.name) && (nameKey(m.name).includes(key) || key.includes(nameKey(m.name))))
          : null;
        code = hit?.code ?? null;
      }
      coupon.appliesToCode = code;
      if (!code) {
        coupon.excludedReason = '未能定位到菜单中的具体商品';
        unquantifiedCoupon += 1;
        continue;
      }
    } else if ((coupon.discountFen ?? 0) > 0) {
      // 订单级满减：不需要定位商品
    } else {
      // 面额型 / 第二份半价等语义与数量相关，无法折成单一优惠额：不猜测，如实标注未量化
      coupon.excludedReason = '面额/规则无法量化（如第二份半价）';
      unquantifiedCoupon += 1;
      continue;
    }

    coupon.usable = true;
    usableCoupons.push(coupon);
  }

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
    coupons: usableCoupons,
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
        // 券在求解阶段已选定并计入券后实付，这里把同一张券带给官方算价做核验
        const couponId = plan.coupon ?? pickBestCoupon(uniqCoupons, plan.totals.priceFen);
        // 官方算价 items 的商品编码字段名是 productCode，不是 code
        const groups = [
          { keys: ['storeCode', 'storeId', 'beCode', 'code'], value: store.code },
          { keys: ['beType'], value: options.beType ?? 1 },
          { keys: ['orderType'], value: options.orderType ?? 1 },
          { keys: ['products', 'meals', 'items', 'productList', 'cart'], value: plan.items.map((item) => ({ productCode: item.code, quantity: 1 })) },
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
          localPayableFen: plan.totals.payableFen,
          officialFen: priced?.totalFen ?? null,
          discountFen: priced?.discountFen ?? plan.discountFen ?? null,
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
  if (matchStats.unmatched > 0) {
    dataNotes.push(`有 ${matchStats.unmatched} 项餐品未匹配到官方营养数据：营养类优化中排除（不使用猜测值），但仍可参与「省钱底线」并在方案中标注营养未知。`);
  }
  dataNotes.push('口径：预算卡的是券前菜单价合计（避免为凑满减券而超支）；结论一律按券后实付排序。');
  if (uniqCoupons.length > 0) {
    dataNotes.push(`发现 ${uniqCoupons.length} 张可用券：${usableCoupons.length} 张可量化并已纳入方案择优`
      + `${unquantifiedCoupon > 0 ? `，${unquantifiedCoupon} 张面额/规则无法量化（如第二份半价）不参与计算` : ''}`
      + `${unusableCoupon > 0 ? `，${unusableCoupon} 张与当前取餐方式不匹配已排除` : ''}；本项目不会自动领券。`);
    dataNotes.push('官方券多为「指定商品用券价」（如某餐品 9.9 元），本工具只在能定位到方案内具体商品时才计入优惠；定位不到的券宁可不算，也不猜一个金额。');
  } else {
    dataNotes.push('本次未查询到可用优惠券，方案按菜单价口径排序（等价于券后实付）。');
  }
  dataNotes.push(...sanity, ...warnings);

  return {
    meta: {
      mode: 'live',
      generatedAt: serverTime
        ? (serverTime?.datetime ?? (typeof serverTime === 'string' ? serverTime : null)) ?? new Date().toISOString().replace('T', ' ').slice(0, 19)
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
    // 可选：把本次取到的原始数据集一并带出，供 --dump-data 固化为可离线运行的网页快照。
    // 同时带上**已解析的营养匹配结果**（含 query-meal-detail 拆解出的套餐营养），
    // 否则网页版会比命令行少掉这部分营养，结论会出现差异。
    ...(options.includeDataset ? {
      dataset: {
        menu: menuItems,
        nutrition: nutritionRows,
        matches: menuItems.map((item) => {
          const entry = nutritionByItem.get(item);
          return {
            code: item.code,
            name: item.name,
            nutrition: entry?.nutrition ?? null,
            matchType: entry?.matchType ?? 'none',
            matchedName: entry?.matchedName ?? null,
          };
        }),
      },
    } : {}),
  };
}

// ---------------------------------------------------------------- 辅助

/** 从 query-meals 返回里抽出商品编码清单（官方仅返回 code 与 tags，分类名作原始分类保留） */
export function extractMenuCodes(payload) {
  const found = [];
  const seen = new Set();
  const visit = (node, cat = null) => {
    if (!node || typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, cat));
      return;
    }
    if (typeof node.code === 'string' && node.code.trim()) {
      if (!seen.has(node.code)) {
        seen.add(node.code);
        found.push({ code: node.code, tags: Array.isArray(node.tags) ? node.tags : [], cat });
      }
    }
    if (typeof node.name === 'string' && Array.isArray(node.meals)) {
      visit(node.meals, node.name);
      return;
    }
    Object.values(node).forEach((v) => visit(v, cat));
  };
  visit(payload);
  return found;
}

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
/**
 * 从一个套餐详情响应里提取「实际组成项」。
 *
 * 官方 `query-meal-detail` 的 Output 规则写明：默认选中的搭配用 `isDefault=1` 标注。
 * 旧实现把整棵响应树（含**全部可选项**）都当组成项累加，导致一份「四件套」被算成
 * 7531 kcal / 蛋白 315 g（正常约 1000–1300 kcal）——那是把"可选的每一样"都加了一遍。
 * 这里改为：只要响应里出现过 isDefault 标记，就**只取默认选中的项**。
 */
export function extractComboParts(payload, menuItems) {
  const found = [];
  let sawDefaultMarker = false;
  const isTrue = (v) => v === 1 || v === true || v === '1';
  const isMarker = (v) => v === 0 || v === 1 || v === '0' || v === '1' || v === true || v === false;

  const visit = (node, depth = 0, parentDefault = false) => {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, depth + 1, parentDefault));
      return;
    }
    const marked = isMarker(node.isDefault);
    if (marked) sawDefaultMarker = true;
    const effectiveDefault = parentDefault || (marked && isTrue(node.isDefault));

    const name = node.name ?? node.productName ?? node.mealName ?? node.itemName;
    if (typeof name === 'string' && name.trim()) {
      const key = nameKey(name);
      const hit = menuItems.find((m) => nameKey(m.name) === key)
        ?? menuItems.find((m) => nameKey(m.name).includes(key) || key.includes(nameKey(m.name)));
      found.push({ name: name.trim(), item: hit ?? null, isDefault: effectiveDefault });
    }
    Object.values(node).forEach((v) => visit(v, depth + 1, effectiveDefault));
  };
  visit(payload);

  // 出现 isDefault 标记 => 只保留默认选中的组成项；否则退回全部项，由离群值守卫兜底
  const selected = sawDefaultMarker ? found.filter((p) => p.isDefault) : found;
  // 去掉与套餐本身同名的项，并按名称去重
  const uniq = new Map();
  for (const part of selected) {
    const key = nameKey(part.name);
    if (!key || !uniq.has(key)) uniq.set(key, part);
  }
  return [...uniq.values()];
}

/** 单个餐品的营养不可能超过这个量级；超出即说明拆解把整棵选项树都加进去了 */
export const COMBO_PLAUSIBLE_LIMITS = { energyKcal: 3000, proteinG: 150, sodiumMg: 6000 };

/** 校验套餐累加结果是否合常理：不合常理时宁可当"未知"，也不喂进优化 */
export function isPlausibleCombo(nutrition) {
  if (!nutrition) return false;
  return (nutrition.energyKcal ?? 0) <= COMBO_PLAUSIBLE_LIMITS.energyKcal
    && (nutrition.proteinG ?? 0) <= COMBO_PLAUSIBLE_LIMITS.proteinG
    && (nutrition.sodiumMg ?? 0) <= COMBO_PLAUSIBLE_LIMITS.sodiumMg;
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

/**
 * 选券：与求解器内使用的口径完全一致（同一订单只核销一张券，取门槛已满足里优惠最大的）。
 * 保留此处导出是为了旧的调用方（CLI / 测试）仍能从这里引用。
 */
export { pickBestCoupon };
