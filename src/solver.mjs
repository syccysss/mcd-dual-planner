/**
 * 双目标配餐求解器：省钱 × 营养
 * ---------------------------------------------------------------
 * 问题定义
 *   决策变量：从门店菜单中选出一个"餐"（默认 1 主食 + 0~2 小食 + 0~1 饮料 + 0~1 甜品）
 *   目标一：实付金额尽可能低（省钱）
 *   目标二：营养达标度尽可能高（营养）
 *   约束：预算上限、品类数量、热量容差、蛋白质下限、钠上限
 *
 * 这不是"随便推荐一个套餐"，而是一个带约束的组合优化问题：
 *   1) 先按品类裁剪候选集（最便宜 / 蛋白性价比最高 / 蛋白最高 / 钠最低 四个方向的并集），
 *      把空间压到可枚举规模，并把裁剪行为写进统计信息里，方便复核；
 *   2) 枚举满足品类规则的组合，用预算剪枝（预算卡券前菜单价，避免为凑券超支）；
 *   3) 对每个组合计算"营养得分"（热量贴合 + 蛋白质达成 + 脂肪控制 − 钠超标惩罚），
 *      并对每个组合套用"门槛已满足里优惠最大的一张券"，得到券后实付；
 *   4) 求 (券后实付, 得分) 的帕累托前沿，并给出三个可执行结论：
 *        营养上限 —— 预算内得分最高
 *        双赢推荐 —— 满足用户全部硬目标（热量区间 / 蛋白下限 / 钠上限）的方案里券后实付最低的
 *        省钱底线 —— 券后实付最低
 *
 * 设计原则：所有"推断"都要能被复核。裁剪了多少、排除了多少、哪些餐品营养未知，
 * 全部通过 stats / excluded 字段返回，报告里如实呈现，绝不假装是穷举最优解。
 */

export const DEFAULT_TARGETS = {
  kcal: 700,
  kcalTolerance: 0.2,
  proteinG: 30,
  sodiumMaxMg: 1200,
  fatMaxG: null, // 缺省按 kcal*0.35/9 推导
};

export const DEFAULT_RULES = {
  主食: { min: 1, max: 1 },
  小食: { min: 0, max: 2 },
  饮料: { min: 0, max: 1 },
  甜品: { min: 0, max: 1 },
  其他: { min: 0, max: 0 },
};

export const DEFAULT_WEIGHTS = {
  energy: 0.4,
  protein: 0.45,
  fat: 0.15,
  sodiumPenaltyMax: 25,
};

/** 双赢门槛：得分达到多少才算"营养合格" */
export const DEFAULT_MIN_SCORE = 70;

const HARD_PLAN_LIMIT = 400_000;

/**
 * 每个品类参与枚举的候选数上限（四个方向的并集，所以单品类实际保留数可达 4×）。
 * 默认取 6 而不是更大的值：枚举规模对「小食」是平方级（C(n,2)），
 * 实测真实门店每品类 8 时会冲到 40 万+ 方案、约 300 MB 堆并触发 HARD_PLAN_LIMIT 截断，
 * 导致输出的是"被砍断的搜索结果"却不自知。6 在真实门店上稳定在 20 余万方案、不触发截断。
 * 想要更强的最优性可用 --per-category 调大，但请留意 truncation 提示。
 */
export const DEFAULT_PER_CATEGORY = 6;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 累加一个方案的总价与总营养，同时记录缺失字段 */
export function sumPlan(items, nutritionByItem) {
  const totals = {
    priceFen: 0,
    energyKcal: 0,
    proteinG: 0,
    fatG: 0,
    carbG: 0,
    sodiumMg: 0,
    calciumMg: 0,
    unknownFields: 0,
    unknownItems: 0,
    // 字段级缺失标记：任一餐品缺该字段即为 true（用于显示与达标判断，缺失 ≠ 0）
    unknown: { energy: false, protein: false, fat: false, carb: false, sodium: false },
  };

  for (const item of items) {
    totals.priceFen += item.priceFen;
    const entry = nutritionByItem.get(item) ?? nutritionByItem.get(item?.name);
    const nutrition = entry?.nutrition ?? null;
    if (!nutrition) {
      totals.unknownItems += 1;
      totals.unknown.energy = true;
      totals.unknown.protein = true;
      totals.unknown.fat = true;
      totals.unknown.carb = true;
      totals.unknown.sodium = true;
      continue;
    }
    let known = 0;
    for (const field of ['energyKcal', 'proteinG', 'fatG', 'carbG', 'sodiumMg']) {
      const value = nutrition[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[field] += value;
        known += 1;
      } else {
        totals.unknownFields += 1;
        totals.unknown[field === 'energyKcal' ? 'energy' : field === 'proteinG' ? 'protein'
          : field === 'fatG' ? 'fat' : field === 'carbG' ? 'carb' : 'sodium'] = true;
      }
    }
    if (nutrition.calciumMg !== null && nutrition.calciumMg !== undefined) totals.calciumMg += nutrition.calciumMg;
    if (known === 0) totals.unknownItems += 1;
  }

  totals.energyKcal = Math.round(totals.energyKcal * 10) / 10;
  totals.proteinG = Math.round(totals.proteinG * 10) / 10;
  totals.fatG = Math.round(totals.fatG * 10) / 10;
  totals.carbG = Math.round(totals.carbG * 10) / 10;
  totals.sodiumMg = Math.round(totals.sodiumMg);
  return totals;
}

/**
 * 营养得分（0~100）。返回分项，便于在报告里解释"为什么是这个分数"。
 */
export function scorePlan(totals, targets = DEFAULT_TARGETS, weights = DEFAULT_WEIGHTS) {
  const targetKcal = targets.kcal;
  const tolerance = targets.kcalTolerance ?? 0.2;
  const targetProtein = targets.proteinG;
  const sodiumMax = targets.sodiumMaxMg;
  const fatMax = targets.fatMaxG ?? (targetKcal * 0.35) / 9;

  const kcalDelta = targetKcal > 0 ? Math.abs(totals.energyKcal - targetKcal) / targetKcal : 0;
  const energyFit = clamp(1 - kcalDelta / Math.max(tolerance, 0.01), 0, 1);

  let proteinFit = targetProtein > 0 ? Math.min(totals.proteinG / targetProtein, 1) : 1;
  if (targetProtein > 0 && totals.proteinG > targetProtein) {
    proteinFit = Math.min(1.15, 1 + ((totals.proteinG - targetProtein) / targetProtein) * 0.15);
  }

  const fatFit = fatMax > 0 ? clamp(1 - Math.max(0, totals.fatG - fatMax) / fatMax, 0, 1) : 1;

  const sodiumOver = sodiumMax > 0 ? Math.max(0, totals.sodiumMg - sodiumMax) / sodiumMax : 0;
  const sodiumPenalty = Math.min(1, sodiumOver) * (weights.sodiumPenaltyMax ?? 25);

  const raw = 100 * (weights.energy * energyFit + weights.protein * proteinFit + weights.fat * fatFit) - sodiumPenalty;
  const score = clamp(raw, 0, 100);

  return {
    score: Math.round(score * 10) / 10,
    parts: {
      energyFit: Number(energyFit.toFixed(3)),
      proteinFit: Number(proteinFit.toFixed(3)),
      fatFit: Number(fatFit.toFixed(3)),
      sodiumPenalty: Number(sodiumPenalty.toFixed(2)),
    },
    derived: {
      targetKcal,
      tolerance,
      targetProtein,
      sodiumMax,
      fatMax: Math.round(fatMax * 10) / 10,
    },
    checks: {
      // 字段缺失时返回 null（未知），绝不把"没数据"当成"达标"
      kcalInRange: totals.unknown?.energy ? null : kcalDelta <= tolerance,
      // 与用户设定的目标口径一致：28 g 对 30 g 的目标就是未达标，不做 90% 打折扣
      proteinMet: totals.unknown?.protein ? null : totals.proteinG >= targetProtein,
      sodiumOk: totals.unknown?.sodium ? null : totals.sodiumMg <= sodiumMax,
      fatOk: totals.unknown?.fat ? null : totals.fatG <= fatMax,
    },
  };
}

/**
 * 候选集裁剪：每个品类取四个方向的并集，另加「营养未知但便宜」方向（仅供省钱底线）。
 * 之所以要裁剪：全量枚举会到千万级组合，而 600 请求/分钟的官方限流意味着
 * 我们不可能对每个组合都调一次算价接口。裁剪是工程必然，关键是把它说清楚。
 *
 * 营养未知品（匹配不到官方营养数据的餐品）默认不参与营养类优化（不猜数），
 * 但**必须**能参与「绝对最便宜」——否则"省钱底线"名不副实。
 * 它们只按价格进入 cheapest-unknown 方向，数量受 unknownPerCategory 控制，
 * 防止组合空间爆炸；其方案得分天然很低，不会误入营养类推荐。
 */
export function selectCandidates(items, nutritionByItem, { perCategory = DEFAULT_PER_CATEGORY, unknownPerCategory = null } = {}) {
  const unknownCap = unknownPerCategory ?? Math.min(perCategory, 6);
  const buckets = new Map();
  for (const item of items) {
    const category = item.category ?? '其他';
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(item);
  }

  const candidates = [];
  const stats = [];

  for (const [category, bucket] of buckets) {
    const scored = bucket.map((item) => {
      const entry = nutritionByItem.get(item) ?? nutritionByItem.get(item?.name);
      const nutrition = entry?.nutrition ?? null;
      const protein = nutrition?.proteinG ?? null;
      const kcal = nutrition?.energyKcal ?? null;
      const sodium = nutrition?.sodiumMg ?? null;
      return {
        item,
        hasNutrition: Boolean(nutrition),
        priceFen: item.priceFen,
        protein,
        kcal,
        sodium,
        proteinPerYuan: protein !== null && item.priceFen > 0 ? protein / (item.priceFen / 100) : null,
        proteinPerKcal: protein !== null && kcal ? protein / kcal : null,
      };
    });

    const withNutrition = scored.filter((s) => s.hasNutrition);
    const withoutNutrition = scored.filter((s) => !s.hasNutrition);
    const chosen = new Map();

    const take = (list, key) => {
      for (const entry of list.slice(0, perCategory)) chosen.set(entry.item, key);
    };

    take([...withNutrition].sort((a, b) => a.priceFen - b.priceFen), 'cheapest');
    take([...withNutrition]
      .filter((s) => s.proteinPerYuan !== null)
      .sort((a, b) => b.proteinPerYuan - a.proteinPerYuan), 'protein-per-yuan');
    take([...withNutrition]
      .filter((s) => s.protein !== null)
      .sort((a, b) => b.protein - a.protein), 'protein-most');
    take([...withNutrition]
      .filter((s) => s.sodium !== null)
      .sort((a, b) => a.sodium - b.sodium), 'sodium-least');
    // 营养未知品：只按价格取最便宜的 unknownCap 个，供「省钱底线」使用
    take([...withoutNutrition].sort((a, b) => a.priceFen - b.priceFen), 'cheapest-unknown');

    candidates.push(...chosen.keys());
    stats.push({
      category,
      inMenu: bucket.length,
      withNutrition: withNutrition.length,
      kept: chosen.size,
      excludedNoNutrition: bucket.length - withNutrition.length - Math.min(withoutNutrition.length, unknownCap),
      unknownKept: Math.min(withoutNutrition.length, unknownCap),
    });
  }

  return { candidates, stats };
}

/**
 * 一个方案套用某张券能省多少钱（分）。官方券有两种形态，这里统一成一个"省多少"的口径：
 *  ① 商品级用券价（`couponPriceFen` + `appliesToCode`）：
 *     方案里含该商品时，省 = 该商品菜单价 − 用券价。用券价是官方明确给出的语义，可放心计算。
 *  ② 订单级满减（`thresholdFen` + `discountFen`）：
 *     门槛已满足才生效，省 = min(面额, 订单合计)，且不会把订单减成负数。
 *  面额型券（第二份半价等）不在此列——语义与数量相关，硬当减免会算错，故返回 0 并如实标注"未量化"。
 */
export function couponSaving(coupon, planItems) {
  if (!coupon || !Array.isArray(planItems) || planItems.length === 0) return 0;
  const totalFen = planItems.reduce((sum, i) => sum + (i.priceFen ?? 0), 0);

  if (coupon.couponPriceFen !== null && coupon.couponPriceFen !== undefined
    && coupon.couponPriceFen > 0 && coupon.appliesToCode) {
    const target = planItems.find((i) => i.code === coupon.appliesToCode);
    return target ? Math.max(0, (target.priceFen ?? 0) - coupon.couponPriceFen) : 0;
  }

  const face = coupon.discountFen ?? 0;
  if (face > 0 && (coupon.thresholdFen ?? 0) <= totalFen) return Math.min(face, totalFen);
  return 0;
}

/** 为一个方案挑出"省得最多"的那张券（同一订单只核销一张）；无券可用返回 null */
export function pickBestCouponForPlan(coupons, planItems) {
  let best = null;
  let bestSaving = 0;
  for (const coupon of coupons) {
    const saving = couponSaving(coupon, planItems);
    if (saving > bestSaving) {
      bestSaving = saving;
      best = coupon;
    }
  }
  return best;
}

/**
 * 选一张门槛已满足、优惠最大的券（订单级满减口径）。
 * 保留给只关心"订单级满减"的调用方（CLI / 测试）；
 * 求解器内部走的是 plan 感知的 `pickBestCouponForPlan`。
 */
export function pickBestCoupon(coupons, priceFen) {
  if (!Array.isArray(coupons) || coupons.length === 0) return null;
  const usable = coupons.filter((c) => (c.thresholdFen ?? 0) <= priceFen && (c.discountFen ?? 0) > 0);
  if (usable.length === 0) return null;
  return usable.sort((a, b) => b.discountFen - a.discountFen)[0];
}

/**
 * 方案成本口径：券后实付（分）。
 * 优惠券只有在"券后实付更低"时才有意义，所以目标函数里的"成本"一律取券后实付；
 * 无券（或旧数据没带 payableFen）时退化为菜单价合计，保证向后兼容。
 */
export function payableFenOf(plan) {
  const t = plan?.totals ?? {};
  return typeof t.payableFen === 'number' ? t.payableFen : (t.priceFen ?? 0);
}

/** 判断 a 是否支配 b（券后实付不高于 b 且得分不低于 b，且至少一项严格更优） */
function dominates(a, b) {
  const ca = payableFenOf(a);
  const cb = payableFenOf(b);
  return ca <= cb
    && a.score >= b.score
    && (ca < cb || a.score > b.score);
}

/**
 * 「达标」的判定口径：用户显式设定的硬目标是否全部满足 —— 热量落在区间内、蛋白不低于下限、
 * 钠不超过上限。三项缺一不可，且**营养未知（null）不算达标**。
 *
 * 为什么不用 `score >= minScore`：复合得分是自定义的序数指标，两项都能被"软性绕过"。
 * 实测过一组真实数据：一个蛋白 29 g 的方案（用户要求 ≥30 g）因总分 83.6 被标成"达标"，
 * 用户看到的就是"我要 30 g，你给我的达标方案是 29 g"。硬目标必须是硬约束。
 * 脂肪是推导出来的软性控制项（不是用户设定），只参与打分，不参与达标判定。
 */
export function meetsUserTargets(plan) {
  const c = plan?.checks ?? {};
  return c.kcalInRange === true && c.proteinMet === true && c.sodiumOk === true;
}

/** 帕累托前沿：按券后实付升序，保留得分严格变高的点 */
export function paretoFront(plans) {
  const sorted = [...plans].sort((a, b) => payableFenOf(a) - payableFenOf(b) || b.score - a.score);
  const front = [];
  let bestScore = -Infinity;
  for (const plan of sorted) {
    if (plan.score > bestScore) {
      // 去掉被同价更低分支配的点
      while (front.length && payableFenOf(front[front.length - 1]) === payableFenOf(plan)) front.pop();
      front.push(plan);
      bestScore = plan.score;
    }
  }
  return front;
}

function planSignature(items) {
  return items.map((i) => i.code ?? i.name).sort().join('|');
}

/**
 * 主求解入口。
 * @returns {{plans: Array, pareto: Array, recommendations: Object, stats: Object}}
 */
export function solve({
  items,
  nutritionByItem,
  targets = DEFAULT_TARGETS,
  budgetFen,
  rules = DEFAULT_RULES,
  weights = DEFAULT_WEIGHTS,
  minScore = DEFAULT_MIN_SCORE,
  perCategory = DEFAULT_PER_CATEGORY,
  maxResults = 200,
  coupons = [],
} = {}) {
  const couponList = Array.isArray(coupons) ? coupons : [];
  const { candidates, stats: candidateStats } = selectCandidates(items, nutritionByItem, { perCategory });

  const byCategory = new Map();
  for (const item of candidates) {
    const category = item.category ?? '其他';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(item);
  }
  for (const list of byCategory.values()) list.sort((a, b) => a.priceFen - b.priceFen);

  const categoryNames = Object.keys(rules);
  const plans = [];
  let enumerated = 0;
  let prunedByBudget = 0;
  let truncated = false;

  const chosen = [];
  const seen = new Set();

  const rec = (index, currentFen, counts) => {
    if (truncated) return;
    if (index === categoryNames.length) {
      // 校验品类数量下限
      for (const name of categoryNames) {
        const rule = rules[name];
        const count = counts[name] ?? 0;
        if (count < (rule.min ?? 0)) return;
      }
      if (chosen.length === 0) return;
      const signature = planSignature(chosen);
      if (seen.has(signature)) return;
      seen.add(signature);

      const planItems = [...chosen];
      const totals = sumPlan(planItems, nutritionByItem);
      const scored = scorePlan(totals, targets, weights);
      // 券进入目标：对每个方案挑"省得最多"的一张券（商品级用券价或订单级满减），
      // 成本口径落到券后实付，这样"省钱"才是用户实际要掏的钱。
      const coupon = couponList.length ? pickBestCouponForPlan(couponList, planItems) : null;
      const discountFen = coupon ? couponSaving(coupon, planItems) : 0;
      totals.discountFen = discountFen;
      totals.payableFen = Math.max(0, totals.priceFen - discountFen);
      enumerated += 1;
      plans.push({
        items: planItems,
        totals,
        score: scored.score,
        parts: scored.parts,
        checks: scored.checks,
        derived: scored.derived,
        coupon,
        discountFen,
        payableFen: totals.payableFen,
      });

      if (plans.length > HARD_PLAN_LIMIT) truncated = true;
      return;
    }

    const name = categoryNames[index];
    const rule = rules[name] ?? { min: 0, max: 0 };
    const pool = byCategory.get(name) ?? [];
    const max = Math.min(rule.max ?? 0, pool.length);

    const branch = (count) => {
      counts[name] = count;
      rec(index + 1, currentFen, counts);
      counts[name] = 0;
    };

    branch(0);
    if (max <= 0) return;

    // 递归选取至多 max 件（组合，不看顺序）
    const pick = (start, depth) => {
      if (truncated) return;
      if (depth > max) return;
      for (let i = start; i < pool.length; i += 1) {
        const item = pool[i];
        const nextFen = currentFen + item.priceFen;
        if (budgetFen !== undefined && budgetFen !== null && nextFen > budgetFen) {
          // 池已按价格升序，后续只会更贵
          prunedByBudget += pool.length - i;
          break;
        }
        chosen.push(item);
        branch(depth);
        pick(i + 1, depth + 1);
        chosen.pop();
      }
    };
    pick(0, 1);
  };

  rec(0, 0, {});

  // 预算口径说明：预算卡的是「券前菜单价」（避免为了凑满减券而超支），
  // 而各结论的择优一律按「券后实付」排序 —— 用户真正关心的是掏多少钱。
  const withinBudget = budgetFen === undefined || budgetFen === null
    ? plans
    : plans.filter((p) => p.totals.priceFen <= budgetFen);

  const byCost = (a, b) => payableFenOf(a) - payableFenOf(b)
    || a.totals.priceFen - b.totals.priceFen
    || b.score - a.score;

  const ranked = [...withinBudget].sort(
    (a, b) => b.score - a.score || payableFenOf(a) - payableFenOf(b) || a.totals.priceFen - b.totals.priceFen,
  );
  const pareto = paretoFront(withinBudget);

  // 「达标」= 用户硬目标全部满足（热量区间 / 蛋白下限 / 钠上限），见 meetsUserTargets。
  // 若没有任何方案达标（目标设得过严时会发生），退回到「得分门槛」并在 stats 里标注
  // qualifyingBasis，让战报如实说明"无方案完全满足全部目标"，而不是把不达标的方案冒充成达标。
  const hardQualifying = withinBudget.filter(meetsUserTargets);
  const scoreQualifying = withinBudget.filter((p) => p.score >= minScore);
  const qualifying = hardQualifying.length ? hardQualifying : scoreQualifying;
  const qualifyingBasis = hardQualifying.length ? 'hard-targets' : 'score-fallback';
  const valueBest = [...qualifying].sort(byCost)[0] ?? null;

  const cheapest = [...withinBudget].sort(byCost)[0] ?? null;

  // 推荐顺序：双赢（达标最便宜） → 预算内最优 → 绝对最便宜，去重后取前 N
  // 每个推荐携带自己的 kind，展示层按 kind 取标题，而不是按数组下标猜角色
  const recommendations = [];
  for (const [candidate, kind] of [
    [valueBest, 'valueBest'],
    [ranked[0] ?? null, 'topScore'],
    [cheapest, 'cheapest'],
  ]) {
    if (!candidate) continue;
    if (recommendations.some((r) => planSignature(r.items) === planSignature(candidate.items))) continue;
    recommendations.push({ ...candidate, kind });
  }

  return {
    plans: ranked.slice(0, maxResults),
    totalPlans: plans.length,
    withinBudget: withinBudget.length,
    pareto,
    recommendations,
    stats: {
      candidateStats,
      candidateCount: candidates.length,
      enumerated,
      totalPlans: plans.length,
      withinBudget: withinBudget.length,
      qualifying: qualifying.length,
      qualifyingBasis,
      hardQualifying: hardQualifying.length,
      scoreQualifying: scoreQualifying.length,
      prunedByBudget,
      truncated,
      budgetFen: budgetFen ?? null,
      minScore,
      perCategory,
      couponCount: couponList.length,
      couponApplied: withinBudget.filter((p) => (p.discountFen ?? 0) > 0).length,
      costBasis: '菜单价过滤预算，券后实付排序',
      dominanceNote: '候选集裁剪后枚举，非全量穷举；裁剪规模见 candidateStats。',
    },
  };
}
