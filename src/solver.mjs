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
 *   2) 枚举满足品类规则的组合，用预算剪枝；
 *   3) 对每个组合计算"营养得分"（热量贴合 + 蛋白质达成 + 脂肪控制 − 钠超标惩罚）；
 *   4) 求 (实付, 得分) 的帕累托前沿，并给出三个可执行结论：
 *        营养上限 —— 预算内得分最高
 *        双赢推荐 —— 达到营养门槛的方案里最便宜的（"用最少的钱跨过门槛"）
 *        省钱底线 —— 绝对最便宜
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
  };

  for (const item of items) {
    totals.priceFen += item.priceFen;
    const entry = nutritionByItem.get(item) ?? nutritionByItem.get(item?.name);
    const nutrition = entry?.nutrition ?? null;
    if (!nutrition) {
      totals.unknownItems += 1;
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
      kcalInRange: kcalDelta <= tolerance,
      proteinMet: totals.proteinG >= targetProtein * 0.9,
      sodiumOk: totals.sodiumMg <= sodiumMax,
      fatOk: totals.fatG <= fatMax,
    },
  };
}

/**
 * 候选集裁剪：每个品类取四个方向的并集。
 * 之所以要裁剪：全量枚举会到千万级组合，而 600 请求/分钟的官方限流意味着
 * 我们不可能对每个组合都调一次算价接口。裁剪是工程必然，关键是把它说清楚。
 */
export function selectCandidates(items, nutritionByItem, { perCategory = 8 } = {}) {
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

    candidates.push(...chosen.keys());
    stats.push({
      category,
      inMenu: bucket.length,
      withNutrition: withNutrition.length,
      kept: chosen.size,
      excludedNoNutrition: bucket.length - withNutrition.length,
    });
  }

  return { candidates, stats };
}

/** 判断 a 是否支配 b（成本不高于 b 且得分不低于 b，且至少一项严格更优） */
function dominates(a, b) {
  return a.totals.priceFen <= b.totals.priceFen
    && a.score >= b.score
    && (a.totals.priceFen < b.totals.priceFen || a.score > b.score);
}

/** 帕累托前沿：按价格升序，保留得分严格变高的点 */
export function paretoFront(plans) {
  const sorted = [...plans].sort((a, b) => a.totals.priceFen - b.totals.priceFen || b.score - a.score);
  const front = [];
  let bestScore = -Infinity;
  for (const plan of sorted) {
    if (plan.score > bestScore) {
      // 去掉被同价更低分支配的点
      while (front.length && front[front.length - 1].totals.priceFen === plan.totals.priceFen) front.pop();
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
  perCategory = 8,
  maxResults = 200,
} = {}) {
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
      enumerated += 1;
      plans.push({
        items: planItems,
        totals,
        score: scored.score,
        parts: scored.parts,
        checks: scored.checks,
        derived: scored.derived,
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

  const withinBudget = budgetFen === undefined || budgetFen === null
    ? plans
    : plans.filter((p) => p.totals.priceFen <= budgetFen);

  const ranked = [...withinBudget].sort((a, b) => b.score - a.score || a.totals.priceFen - b.totals.priceFen);
  const pareto = paretoFront(withinBudget);

  const qualifying = withinBudget.filter((p) => p.score >= minScore);
  const valueBest = [...qualifying].sort(
    (a, b) => a.totals.priceFen - b.totals.priceFen || b.score - a.score,
  )[0] ?? null;

  const cheapest = [...withinBudget].sort(
    (a, b) => a.totals.priceFen - b.totals.priceFen || b.score - a.score,
  )[0] ?? null;

  // 推荐顺序：双赢（达标最便宜） → 预算内最优 → 绝对最便宜，去重后取前 N
  const recommendations = [];
  for (const candidate of [valueBest, ranked[0] ?? null, cheapest]) {
    if (!candidate) continue;
    if (recommendations.some((r) => planSignature(r.items) === planSignature(candidate.items))) continue;
    recommendations.push(candidate);
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
      prunedByBudget,
      truncated,
      budgetFen: budgetFen ?? null,
      minScore,
      perCategory,
      dominanceNote: '候选集裁剪后枚举，非全量穷举；裁剪规模见 candidateStats。',
    },
  };
}
