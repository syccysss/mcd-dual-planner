/**
 * 归一化层：把麦当劳 MCP 的原始返回转成引擎可以计算的稳定结构
 * ---------------------------------------------------------------
 * 为什么需要这一层：
 *  1. 官方不同工具/不同版本返回的字段名不完全一致（price / priceFen / amount…），
 *     与其硬编码字段名，不如按"形状"容错提取，并在报告里保留原始来源。
 *  2. 单位存在歧义：能量可能是 kJ 也可能是 kcal，钠可能是 g 也可能是 mg。
 *     所有自动换算都会标记 inferred=true，把"我们推断过"这件事写在明面上，
 *     绝不把推断值伪装成官方原值。
 *  3. 菜单名称（"巨无霸三件套"）与营养库名称（"巨无霸"）需要名称匹配，
 *     匹配失败就诚实地留空，而不是编一个近似数字。
 */

export const FEN_PER_YUAN = 100;

// ---------------------------------------------------------------- 基础工具

/** 全角转半角 + 去零宽字符 */
function toHalfWidth(input) {
  return String(input)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

export function fenToYuan(fen) {
  if (!Number.isFinite(fen)) return null;
  return Math.round(fen) / FEN_PER_YUAN;
}

export function formatYuan(fen, { withSymbol = false } = {}) {
  const yuan = fenToYuan(fen);
  if (yuan === null) return '—';
  return `${withSymbol ? '¥' : ''}${yuan.toFixed(2)}`;
}

export function yuanToFen(yuan) {
  return Math.round(Number(yuan) * FEN_PER_YUAN);
}

/** 取第一个"有值"的键（undefined / null / '' 都算没值） */
export function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** 数字容错：允许 "12.5"、"12.5元"、"¥12.5"、"1,234" */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = toHalfWidth(value).replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** 深度遍历任意 JSON 结构 */
export function walk(node, visit, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const value of Object.values(node)) walk(value, visit, depth + 1);
}

/** 遍历并收集所有满足条件的对象 */
function collect(node, predicate) {
  const out = [];
  walk(node, (obj) => {
    if (predicate(obj)) out.push(obj);
  });
  return out;
}

// ---------------------------------------------------------------- 字段别名

const NAME_KEYS = ['name', 'foodName', 'food_name', 'productName', 'product_name', 'mealName', 'meal_name',
  'itemName', 'item_name', 'skuName', 'sku_name', 'title', 'cnName', 'dishName', 'goodsName'];
const CODE_KEYS = ['code', 'productCode', 'product_code', 'mealCode', 'meal_code', 'skuCode', 'sku_code',
  'itemCode', 'itemId', 'item_id', 'skuId', 'sku_id', 'spuId', 'spu_id', 'id', 'goodsCode'];
const PRICE_KEYS = ['price', 'priceFen', 'price_fen', 'unitPrice', 'unit_price', 'salePrice', 'sale_price',
  'currentPrice', 'current_price', 'amount', 'payAmount', 'pay_amount', 'totalPrice', 'total_price', 'originalPrice'];
const CATEGORY_KEYS = ['category', 'categoryName', 'category_name', 'typeName', 'type_name', 'groupName',
  'group_name', 'parentName', 'parent_name', 'classifyName', 'secondCategoryName'];
const TAG_KEYS = ['tags', 'tag', 'labels', 'marks', 'spuTags'];

const ENERGY_KEYS_KCAL = ['energyKcal', 'energy_kcal', 'kcal', 'calorie', 'calories', 'heat', '热量'];
const ENERGY_KEYS_ANY = ['energy', 'energyValue', 'energy_value', 'energyKj', 'energy_kj'];
const PROTEIN_KEYS = ['protein', 'proteinG', 'protein_g', 'proteinValue', 'protein_value', '蛋白质'];
const FAT_KEYS = ['fat', 'fatG', 'fat_g', 'fatValue', 'fat_value', '脂肪'];
const CARB_KEYS = ['carbohydrate', 'carbohydrates', 'carbohydrateG', 'carbohydrate_g', 'carb', 'carbG',
  'carb_g', 'carbon', 'carbonWater', 'carbon_water', '碳水化合物'];
const SODIUM_KEYS = ['sodium', 'sodiumMg', 'sodium_mg', 'na', 'naMg', 'na_mg', '钠'];
const CALCIUM_KEYS = ['calcium', 'calciumMg', 'calcium_mg', 'ca', 'caMg', '钙'];

/** 能量字段名里出现这些词，说明单位是 kJ */
const KJ_MARKERS = /(kj|千焦)/i;
/** 单个餐品能量超过这个值几乎不可能是 kcal（一份套餐最多 ~1500 kcal） */
const KCAL_SANITY_LIMIT = 1600;

// ---------------------------------------------------------------- 名称处理

const SPEC_TOKENS = [
  '中杯', '大杯', '小杯', '超大杯', '标准杯', '单份', '双份', '加大', '标准', '常规', '小份', '大份',
  '1份', '一份', '单人餐', '套餐', '组合', '新品', '限时', '经典', '可选', '默认',
];

/** 生成用于匹配的规范化键：去规格词、去括号内容、去标点、转小写 */
export function nameKey(rawName) {
  if (!rawName) return '';
  let s = toHalfWidth(rawName).toLowerCase();
  s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '');
  s = s.replace(/[\s\-_/\\·、,，。.。!！?？:：;；"'“”‘’*+~@#&|<>]/g, '');
  for (const token of SPEC_TOKENS) s = s.split(token).join('');
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  return s.trim();
}

/** 粗粒度品类推断：接口没给品类时兜底，报告中标记为 inferred */
const CATEGORY_RULES = [
  ['饮料', ['可乐', '雪碧', '芬达', '咖啡', '拿铁', '美式', '茶', '奶茶', '果汁', '橙汁', '牛奶', '豆浆',
    '柠檬', '气泡', '矿泉水', '饮用水', '奶昔', '冰淇淋饮料', '麦咖啡', '卡布', '摩卡', '苏打', '椰']],
  ['甜品', ['冰淇淋', '新地', '麦旋风', '派', '蛋糕', '甜筒', '圣代', '布丁', '马卡龙', '可颂', '司康']],
  ['小食', ['薯条', '薯格', '鸡块', '鸡翅', '鸡腿', '鸡排', '玉米', '沙拉', '汤', '洋葱圈', '小食',
    '麦乐鸡', '麦辣鸡翅', '扭扭薯条', '苹果片', '蔬菜杯', '麦辣鸡腿']],
  ['主食', ['汉堡', '巨无霸', '麦辣', '双层', '吉士', '板烧', '鱼堡', '牛肉堡', '鸡肉堡', '卷', '堡',
    '饭', '意面', '粥', '油条', '松饼', '热香饼', '早餐', '全餐', '帕尼尼', '贝果', '吐司', '可颂堡']],
];

export function inferCategory(name, rawCategory) {
  const text = String(rawCategory ?? '');
  if (text) {
    for (const [category, keywords] of CATEGORY_RULES) {
      if (keywords.some((k) => text.includes(k)) || text.includes(category)) {
        return { category, inferred: false };
      }
    }
  }
  const target = String(name ?? '');
  for (const [category, keywords] of CATEGORY_RULES) {
    if (keywords.some((k) => target.includes(k))) return { category, inferred: true };
  }
  return { category: '其他', inferred: true };
}

// ---------------------------------------------------------------- 菜单

function looksLikeMenuItem(obj) {
  const name = pick(obj, NAME_KEYS);
  if (typeof name !== 'string' || !name.trim()) return false;
  const price = pick(obj, PRICE_KEYS);
  return toNumber(price) !== null;
}

/**
 * 归一化菜单。价格统一为「分」。
 * @returns {{items: Array, rawCount: number}}
 */
export function normalizeMenu(payload) {
  const nodes = collect(payload, looksLikeMenuItem);
  const byKey = new Map();

  for (const node of nodes) {
    const name = String(pick(node, NAME_KEYS)).trim();
    const rawPrice = toNumber(pick(node, PRICE_KEYS));
    if (rawPrice === null) continue;

    // 价格单位判断：字段名带 yuan/元 视为元，其余按官方约定视为分
    const priceKey = PRICE_KEYS.find((k) => node[k] !== undefined && node[k] !== null && node[k] !== '');
    const looksYuan = /yuan|元/i.test(String(priceKey ?? ''));
    const priceFen = looksYuan ? yuanToFen(rawPrice) : Math.round(rawPrice);

    const code = pick(node, CODE_KEYS);
    const rawCategory = pick(node, CATEGORY_KEYS);
    const { category, inferred } = inferCategory(name, rawCategory);
    const tags = pick(node, TAG_KEYS);

    const key = nameKey(name) || name;
    const item = {
      code: code === undefined ? null : String(code),
      name,
      priceFen,
      priceSource: 'menu',
      category,
      categoryInferred: inferred,
      rawCategory: rawCategory === undefined ? null : String(rawCategory),
      tags: Array.isArray(tags) ? tags.map((t) => (typeof t === 'string' ? t : String(t?.name ?? ''))) : [],
    };

    const existing = byKey.get(key);
    // 同名取更便宜的（多为同一商品的不同展示位）
    if (!existing || item.priceFen < existing.priceFen) byKey.set(key, item);
  }

  return { items: [...byKey.values()], rawCount: nodes.length };
}

// ---------------------------------------------------------------- 营养

/**
 * 解析官方营养库的 toon 紧凑格式，例如：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 * 返回与 collect 路径一致的行结构，供 normalizeNutrition 统一使用。
 */
export function parseToonTable(text) {
  if (typeof text !== 'string') return [];
  const match = text.match(/\[(\d+)\]\{([^}]+)\}:/);
  const headerLine = match ? match[2] : text.split('\n')[0];
  const header = headerLine.split(',').map((h) => h.trim());
  const rows = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('[') || line.startsWith('{')) continue;
    const cells = line.split(',').map((c) => c.trim());
    const row = {};
    for (let i = 0; i < header.length; i += 1) {
      const value = cells[i];
      row[header[i]] = value === 'null' || value === '' ? null : value;
    }
    if (row.productName) rows.push(row);
  }
  return rows;
}

function looksLikeNutrition(obj) {
  const name = pick(obj, NAME_KEYS);
  if (typeof name !== 'string' || !name.trim()) return false;
  const hasEnergy = pick(obj, [...ENERGY_KEYS_KCAL, ...ENERGY_KEYS_ANY]) !== undefined;
  const hasMacro = [PROTEIN_KEYS, FAT_KEYS, CARB_KEYS, SODIUM_KEYS].some((keys) => pick(obj, keys) !== undefined);
  return hasEnergy || hasMacro;
}

/** 单项营养提取，含单位推断 */
export function extractNutrition(node) {
  const inferred = [];

  // 能量：优先明确标注 kcal 的字段
  let energyKcal = toNumber(pick(node, ENERGY_KEYS_KCAL));
  if (energyKcal === null) {
    const anyKey = ENERGY_KEYS_ANY.find((k) => node[k] !== undefined && node[k] !== null && node[k] !== '');
    const rawEnergy = toNumber(pick(node, ENERGY_KEYS_ANY));
    if (rawEnergy !== null) {
      if (KJ_MARKERS.test(String(anyKey ?? ''))) {
        energyKcal = Math.round((rawEnergy / 4.184) * 10) / 10;
        inferred.push('能量按 kJ→kcal 换算');
      } else if (rawEnergy > KCAL_SANITY_LIMIT) {
        energyKcal = Math.round((rawEnergy / 4.184) * 10) / 10;
        inferred.push('能量数值超出单份合理范围，按 kJ→kcal 换算');
      } else {
        energyKcal = rawEnergy;
      }
    }
  }

  let sodiumMg = toNumber(pick(node, SODIUM_KEYS));
  if (sodiumMg !== null && sodiumMg > 0 && sodiumMg < 10) {
    // 钠以克为单位给出时数值通常 < 10
    sodiumMg = Math.round(sodiumMg * 1000);
    inferred.push('钠按 g→mg 换算');
  }

  return {
    energyKcal,
    proteinG: toNumber(pick(node, PROTEIN_KEYS)),
    fatG: toNumber(pick(node, FAT_KEYS)),
    carbG: toNumber(pick(node, CARB_KEYS)),
    sodiumMg,
    calciumMg: toNumber(pick(node, CALCIUM_KEYS)),
    inferred,
  };
}

export function normalizeNutrition(payload) {
  // toon 紧凑格式：官方营养库的 data 字段本身就是这种文本（或包在 {data: "..."} 里）
  if (typeof payload === 'string') payload = parseToonTable(payload);
  else if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.data === 'string') {
    payload = parseToonTable(payload.data);
  }

  // 形态兼容：数组 / { list: [...] } / { "巨无霸": {...} } 映射表
  const nodes = collect(payload, looksLikeNutrition);
  const rows = [];

  for (const node of nodes) {
    const name = String(pick(node, NAME_KEYS)).trim();
    const nutrition = extractNutrition(node);
    const hasAnyValue = [nutrition.energyKcal, nutrition.proteinG, nutrition.fatG, nutrition.carbG, nutrition.sodiumMg]
      .some((v) => v !== null);
    if (!hasAnyValue) continue;
    rows.push({ name, key: nameKey(name), ...nutrition });
  }

  // 映射表形态：键名当餐品名
  if (rows.length === 0 && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (!value || typeof value !== 'object') continue;
      const nutrition = extractNutrition(value);
      const hasAnyValue = [nutrition.energyKcal, nutrition.proteinG, nutrition.fatG, nutrition.sodiumMg]
        .some((v) => v !== null);
      if (hasAnyValue) rows.push({ name: key, key: nameKey(key), ...nutrition });
    }
  }

  const byKey = new Map();
  for (const row of rows) {
    const dedupeKey = row.key || row.name;
    if (!byKey.has(dedupeKey)) byKey.set(dedupeKey, row);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------- 匹配

function tokenOverlap(a, b) {
  const ta = new Set(a.split('').filter(Boolean));
  const tb = new Set(b.split('').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const ch of ta) if (tb.has(ch)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

/**
 * 菜单项 → 营养行 的匹配。
 * 匹配策略（依次退化，全部记录 matchType 以便审计）：
 *   exact     规范化后完全相同
 *   contains  一方包含另一方（"巨无霸三件套" ⊃ "巨无霸" 这类需要额外拆解，不在本层处理）
 *   fuzzy     字符重合度 ≥ 0.72
 *   none      匹配不上 —— 引擎会把它当作"营养未知"，绝不猜数
 */
export function matchNutrition(menuItems, nutritionRows) {
  const exact = new Map();
  for (const row of nutritionRows) exact.set(row.key || nameKey(row.name), row);

  const result = new Map();
  for (const item of menuItems) {
    const key = nameKey(item.name);
    if (!key) {
      result.set(item, { nutrition: null, matchType: 'none', matchedName: null });
      continue;
    }
    if (exact.has(key)) {
      result.set(item, { nutrition: exact.get(key), matchType: 'exact', matchedName: exact.get(key).name });
      continue;
    }

    let best = null;
    let bestScore = 0;
    for (const row of nutritionRows) {
      const rowKey = row.key || nameKey(row.name);
      if (!rowKey) continue;
      if (key.includes(rowKey) || rowKey.includes(key)) {
        const score = 0.8 + Math.min(rowKey.length, key.length) / (Math.max(rowKey.length, key.length) * 10);
        if (score > bestScore) {
          best = row;
          bestScore = score;
        }
      } else {
        const score = tokenOverlap(key, rowKey);
        if (score > bestScore) {
          best = row;
          bestScore = score;
        }
      }
    }

    if (best && bestScore >= 0.72) {
      const type = key.includes(best.key || nameKey(best.name)) || (best.key || nameKey(best.name)).includes(key)
        ? 'contains'
        : 'fuzzy';
      result.set(item, { nutrition: best, matchType: type, matchedName: best.name, confidence: Number(bestScore.toFixed(2)) });
    } else {
      result.set(item, { nutrition: null, matchType: 'none', matchedName: best?.name ?? null });
    }
  }
  return result;
}

// ---------------------------------------------------------------- 优惠券 / 算价

/** 把 1 / [1] / [1,5] 这类取值统一成整数数组 */
function toIntArray(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((v) => toNumber(v)).filter((v) => v !== null).map((v) => Math.trunc(v)))];
}

/**
 * 优惠券归一化。
 *
 * 官方券有两种形态，字段完全不同，必须分开建模：
 *  ① 订单级满减：门槛 + 面额（本项目演示数据用这种）
 *  ② 商品级用券价：`discountInfo = { discountDesc: "用券价格", discountValue: "9.9" }`，
 *     表示"适用商品可按 ¥9.9 购买"；适用商品在 `products[].productCode`，
 *     若该券来自用户卡包则需按 `id` / `promotionId` 与门店券合并才能拿到商品编码。
 *
 * 面额型（denomination / tenderAmount）只记录不参与计算：官方出现「第二份半价」这类
 * 数量相关的券，名义面额不等于真实优惠，硬当减免会算出错误结论——宁可标注"未量化"。
 */
export function normalizeCoupons(payload) {
  const nodes = collect(payload, (obj) => {
    const name = pick(obj, NAME_KEYS);
    if (typeof name !== 'string' || !name.trim()) return false;
    return pick(obj, ['couponId', 'coupon_id', 'id', 'code']) !== undefined;
  });

  const byId = new Map();
  for (const node of nodes) {
    const rawId = pick(node, ['couponId', 'coupon_id', 'id', 'code']);
    if (rawId === undefined || rawId === null) continue;
    const id = String(rawId);
    const name = String(pick(node, NAME_KEYS)).trim();

    const discountFen = toNumber(pick(node, ['discountAmount', 'discount_amount', 'discount', 'amount',
      'reduceAmount', 'reduce_amount', 'faceValue']));
    const thresholdFen = toNumber(pick(node, ['threshold', 'minAmount', 'min_amount', 'conditionAmount',
      'limitAmount', 'useCondition']));

    // 商品级用券价：仅当语义明确（discountDesc 含"用券价"）且数值为正时采信
    const info = node.discountInfo && typeof node.discountInfo === 'object' ? node.discountInfo : null;
    const desc = info ? String(pick(info, ['discountDesc', 'discount_desc']) ?? '') : '';
    const infoValue = info ? toNumber(pick(info, ['discountValue', 'discount_value'])) : null;
    const couponPriceFen = desc.includes('用券价') && infoValue !== null && infoValue > 0
      ? Math.round(infoValue * 100)
      : null;

    const faceValueFen = toNumber(pick(node, ['denomination', 'tenderAmount', 'tender_amount',
      'currentBalance', 'balance']));

    const products = Array.isArray(node.products) ? node.products : [];
    const targetCodes = [];
    for (const p of products) {
      const code = pick(p, ['productCode', 'product_code', 'mealCode', 'code']);
      if (code !== undefined && code !== null) targetCodes.push(String(code));
    }

    const entry = {
      id,
      name,
      thresholdFen: thresholdFen === null ? null : Math.round(thresholdFen),
      discountFen: discountFen === null ? null : Math.round(discountFen),
      couponPriceFen,
      faceValueFen: faceValueFen === null ? null : Math.round(faceValueFen),
      targetCodes: [...new Set(targetCodes)],
      appliesToCode: null, // 由 pipeline 结合菜单解析后回填
      promotionId: pick(node, ['promotionId', 'promotion_id']) !== undefined
        ? String(pick(node, ['promotionId', 'promotion_id'])) : null,
      orderTypes: toIntArray(pick(node, ['orderTypes', 'orderType'])),
      beTypes: toIntArray(pick(node, ['beTypes', 'beType'])),
      expireAt: pick(node, ['expireTime', 'expire_time', 'endTime', 'end_time', 'validEndTime', 'expireDate',
        'tradeEndDateTime', 'tradeEndDate']) ?? null,
      scope: pick(node, ['scope', 'useScope', 'channel']) ?? null,
    };

    // 同一张券可能同时出现在门店券（有 products）与卡包券（有 discountInfo）里：
    // 按 id 合并，而不是后者覆盖前者，否则会丢掉适用商品或面额。
    byId.set(id, mergeCoupon(byId.get(id), entry));
  }
  return [...byId.values()];
}

/** 合并同一张券的两份视图：字段级取"更具体"的一份，适用商品取并集 */
export function mergeCoupon(prev, next) {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    name: next.name || prev.name,
    thresholdFen: next.thresholdFen ?? prev.thresholdFen,
    discountFen: next.discountFen ?? prev.discountFen,
    couponPriceFen: next.couponPriceFen ?? prev.couponPriceFen,
    faceValueFen: next.faceValueFen ?? prev.faceValueFen,
    promotionId: next.promotionId ?? prev.promotionId,
    targetCodes: [...new Set([...(prev.targetCodes ?? []), ...(next.targetCodes ?? [])])],
    orderTypes: next.orderTypes?.length ? next.orderTypes : prev.orderTypes,
    beTypes: next.beTypes?.length ? next.beTypes : prev.beTypes,
  };
}

/**
 * 算价结果归一化。官方返回单位是「分」，这里统一保留分并给出元。
 * 字段缺失时返回 null 而不是 0 —— 0 元和"没返回"是两回事。
 */
export function normalizePrice(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const obj = Array.isArray(payload) ? payload.find((x) => x && typeof x === 'object') ?? null : payload;
  if (!obj) return null;

  const nested = obj.priceInfo ?? obj.price ?? obj.amount ?? obj.result ?? null;
  let source = nested && typeof nested === 'object' ? { ...obj, ...nested } : obj;

  const TOTAL_KEYS = ['price', 'totalAmount', 'total_amount', 'payAmount', 'pay_amount', 'totalPrice', 'total_price',
    'amount', 'actualAmount', 'actual_amount', 'finalAmount'];

  // 兜底：字段可能包在未知层级的 data / result / orderInfo 里，
  // 直接在整棵树上找"同时含总价字段"的对象，避免因为一层包装就取不到金额。
  if (toNumber(pick(source, TOTAL_KEYS)) === null) {
    const candidates = collect(payload, (o) => toNumber(pick(o, TOTAL_KEYS)) !== null && o !== obj);
    if (candidates.length > 0) source = { ...obj, ...candidates[0] };
  }

  const totalFen = toNumber(pick(source, TOTAL_KEYS));
  const discountFen = toNumber(pick(source, ['discountAmount', 'discount_amount', 'discount', 'couponAmount',
    'coupon_amount', 'reduceAmount', 'reduce_amount']));
  const deliveryFen = toNumber(pick(source, ['deliveryFee', 'delivery_fee', 'freight', 'shippingFee', 'packingFee']));
  const originalFen = toNumber(pick(source, ['originalAmount', 'original_amount', 'originAmount', 'listAmount']));

  const lines = collect(source, (o) => {
    const name = pick(o, NAME_KEYS);
    const amount = pick(o, ['amount', 'price', 'totalAmount', 'total_amount', 'subtotal', 'payAmount']);
    return typeof name === 'string' && name.trim() && toNumber(amount) !== null && o !== source;
  }).map((o) => ({
    name: String(pick(o, NAME_KEYS)).trim(),
    amountFen: Math.round(toNumber(pick(o, ['amount', 'price', 'totalAmount', 'total_amount', 'subtotal', 'payAmount']))),
    quantity: toNumber(pick(o, ['quantity', 'count', 'num', 'qty'])) ?? 1,
  }));

  return {
    totalFen: totalFen === null ? null : Math.round(totalFen),
    originalFen: originalFen === null ? null : Math.round(originalFen),
    discountFen: discountFen === null ? null : Math.round(discountFen),
    deliveryFen: deliveryFen === null ? null : Math.round(deliveryFen),
    lines,
    raw: source,
  };
}

// ---------------------------------------------------------------- 门店

export function normalizeStores(payload) {
  const nodes = collect(payload, (obj) => {
    const name = pick(obj, ['storeName', 'store_name', 'name', 'shopName', 'restaurantName']);
    const code = pick(obj, ['beCode', 'be_code', 'storeCode', 'store_code', 'code', 'id', 'storeId']);
    return typeof name === 'string' && name.trim() && code !== undefined && code !== null;
  });

  const byCode = new Map();
  for (const node of nodes) {
    const code = String(pick(node, ['beCode', 'be_code', 'storeCode', 'store_code', 'code', 'id', 'storeId']));
    byCode.set(code, {
      code,
      name: String(pick(node, ['storeName', 'store_name', 'name', 'shopName', 'restaurantName'])).trim(),
      address: pick(node, ['address', 'storeAddress', 'addr', 'fullAddress']) ?? null,
      distance: pick(node, ['distance', 'distanceText', 'distanceMeter']) ?? null,
      city: pick(node, ['cityName', 'city', 'cityCode']) ?? null,
      supportsReservation: pick(node, ['reservation', 'supportReservation', 'canReserve']) ?? null,
    });
  }
  return [...byCode.values()];
}

// ---------------------------------------------------------------- 校验

/** 判断菜单项价格是否像"分"：官方约定为分，这里只做异常提示 */
export function sanityCheckMenu(items) {
  const warnings = [];
  const suspicious = items.filter((i) => i.priceFen > 0 && i.priceFen < 100);
  if (suspicious.length > 0 && suspicious.length >= items.length * 0.5) {
    warnings.push(`有 ${suspicious.length}/${items.length} 个餐品价格小于 1 元，可能接口单位不是「分」，请核对原始返回。`);
  }
  const noCode = items.filter((i) => !i.code).length;
  if (noCode > 0) warnings.push(`有 ${noCode} 个餐品缺少商品编码，下单/算价前需要人工确认。`);
  return warnings;
}
