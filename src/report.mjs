/**
 * 战报渲染器：把求解结果画成一张自包含的 SVG 战报
 * ---------------------------------------------------------------
 * 为什么选 SVG 而不是 HTML：
 *  1. 单文件、无外链、可离线打开，直接丢进聊天窗口就能看；
 *  2. 可被 LibreOffice / 浏览器 / 设计工具无损转成 PNG，方便做项目封面；
 *  3. 文本可搜索、可 diff，评审想核对哪个数字都行。
 *
 * 中文字宽在 SVG 里不会自动换行，所以这里实现了按"显示宽度"折行的排版器
 * （CJK 记 2 个单位、ASCII 记 1 个单位），避免长餐品名溢出卡片。
 */

import { payableFenOf } from './solver.mjs';

const C = {
  red: '#DA291C',
  yellow: '#FFC72C',
  ink: '#1A1A1A',
  sub: '#6B6B6B',
  line: '#E3E3E3',
  bg: '#FFFFFF',
  card: '#FFF9E8',
  good: '#1E7F3C',
  warn: '#B26B00',
  bad: '#C0392B',
  chart: '#2E5AAC',
};

const FONT = "'PingFang SC','Microsoft YaHei','Noto Sans SC','Source Han Sans SC',-apple-system,sans-serif";

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 显示宽度：CJK 与全角标点算 2，其余算 1 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? '')) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return width;
}

/** 按显示宽度折行 */
export function wrapText(text, maxUnits) {
  const lines = [];
  let current = '';
  let width = 0;
  for (const ch of String(text ?? '')) {
    const w = displayWidth(ch);
    if (width + w > maxUnits && current) {
      lines.push(current);
      current = ch;
      width = w;
    } else {
      current += ch;
      width += w;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const el = {
  rect(x, y, w, h, { rx = 0, fill = 'none', stroke = 'none', sw = 1, opacity = 1 } = {}) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
  },
  text(x, y, content, { size = 14, weight = 400, fill = C.ink, anchor = 'start', opacity = 1 } = {}) {
    return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}">${escapeXml(content)}</text>`;
  },
  lines(x, y, content, { size = 14, weight = 400, fill = C.ink, maxUnits = 40, lineHeight = null, anchor = 'start' } = {}) {
    const lh = lineHeight ?? Math.round(size * 1.5);
    return wrapText(content, maxUnits)
      .map((line, i) => el.text(x, y + i * lh, line, { size, weight, fill, anchor }))
      .join('');
  },
  line(x1, y1, x2, y2, { stroke = C.line, sw = 1, dash = null } = {}) {
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  },
  circle(cx, cy, r, { fill = C.red, stroke = 'none', sw = 1, opacity = 1 } = {}) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" opacity="${opacity}"/>`;
  },
  bar(x, y, w, h, ratio, { fill = C.good, bg = '#EFEFEF', rx = 4 } = {}) {
    const clamped = Math.min(1, Math.max(0, ratio));
    return el.rect(x, y, w, h, { rx, fill: bg }) + el.rect(x, y, Math.max(2, w * clamped), h, { rx, fill });
  },
};

const yuan = (fen) => (Number.isFinite(fen) ? (fen / 100).toFixed(2) : '—');

const KIND_LABELS = {
  valueBest: '双赢推荐',
  topScore: '营养上限',
  cheapest: '省钱底线',
};

function planTitle(plan, index) {
  return KIND_LABELS[plan.kind] ?? `方案 ${String.fromCharCode(65 + index)}`;
}

function planReason(plan, index, targets, basis) {
  const t = plan.totals;
  const paid = t.discountFen > 0
    ? `券后实付 ¥${yuan(t.payableFen)}（菜单价 ¥${yuan(t.priceFen)} − 券 ¥${yuan(t.discountFen)}）`
    : `¥${yuan(t.priceFen)}`;
  if (plan.kind === 'valueBest') {
    // 达标口径可能已退化（没有任何方案满足用户设定的硬目标）——此时不能说"满足全部硬目标"，
    // 因为那是假话；如实说明"这是最接近的一档"，与 stats.qualifyingBasis 一致。
    if (basis === 'score-fallback') {
      return `没有方案完全满足硬目标（热量区间 / 蛋白下限 / 钠上限），这是最接近的一档：${paid} 换 ${t.proteinG} g 蛋白`;
    }
    return `满足全部硬目标（热量区间 + 蛋白下限 + 钠上限）里券后最便宜的一档：${paid} 换 ${t.proteinG} g 蛋白`;
  }
  if (plan.kind === 'topScore') return `预算内营养得分最高：${plan.score} 分，热量 ${t.energyKcal} kcal（目标 ${targets.kcal} kcal）`;
  if (plan.kind === 'cheapest') return `券后实付最低：${paid}，热量 ${t.energyKcal} kcal，得分 ${plan.score}`;
  return `候选方案：${paid}，热量 ${t.energyKcal} kcal，得分 ${plan.score}`;
}

function drawPlanCard(plan, index, ctx) {
  const { x, y, w } = ctx;
  const items = plan.items;
  const itemLines = items.flatMap((item) => {
    const wrapped = wrapText(item.name, 30);
    return wrapped.map((line, i) => ({
      text: i === 0 ? line : line,
      price: i === 0 ? `¥${yuan(item.priceFen)}` : '',
    }));
  });

  const headerH = 78;
  const bodyH = itemLines.length * 22 + 16;
  const meterH = 74;
  const reasonH = 46;
  const h = headerH + bodyH + meterH + reasonH;
  const t = plan.totals;

  const parts = [
    el.rect(x, y, w, h, { rx: 12, fill: C.card, stroke: '#F0DDA8', sw: 1 }),
  ];

  // 头部
  parts.push(el.rect(x, y, 6, h, { rx: 3, fill: index === 0 ? C.red : C.yellow }));
  parts.push(el.text(x + 20, y + 30, planTitle(plan, index), { size: 17, weight: 700, fill: C.ink }));
  const badgeFill = plan.score >= ctx.minScore ? C.good : C.warn;
  parts.push(el.rect(x + w - 132, y + 14, 112, 26, { rx: 13, fill: badgeFill, opacity: 0.12 }));
  parts.push(el.text(x + w - 76, y + 32, `营养 ${plan.score} 分`, { size: 13, weight: 600, fill: badgeFill, anchor: 'middle' }));
  const unknownTag = t.unknownItems > 0 ? ` · 营养未知 ${t.unknownItems} 项` : '';
  const couponTag = t.discountFen > 0 ? ` · 券 −¥${yuan(t.discountFen)}` : '';
  const num = (v, unknown) => (unknown ? '—' : v);
  parts.push(el.text(x + 20, y + 52, `券后实付 ¥${yuan(t.payableFen)}（菜单价 ¥${yuan(t.priceFen)}）${couponTag} · ${num(t.energyKcal, t.unknown?.energy)} kcal · 蛋白 ${num(t.proteinG, t.unknown?.protein)} g · 钠 ${num(t.sodiumMg, t.unknown?.sodium)} mg${unknownTag}`,
    { size: 12.5, fill: C.sub }));

  // 明细
  let ly = y + headerH;
  for (const line of itemLines) {
    parts.push(el.text(x + 20, ly, line.text, { size: 13.5, fill: C.ink }));
    if (line.price) parts.push(el.text(x + w - 20, ly, line.price, { size: 13.5, fill: C.sub, anchor: 'end' }));
    ly += 22;
  }

  // 双目标进度条
  const meterY = ly + 10;
  const meterW = w - 40;
  const costRatio = ctx.budgetFen > 0 ? payableFenOf(plan) / ctx.budgetFen : 0;
  parts.push(el.text(x + 20, meterY, '预算占用', { size: 11.5, fill: C.sub }));
  parts.push(el.bar(x + 100, meterY - 9, meterW - 80, 10, costRatio, { fill: costRatio > 1 ? C.bad : C.chart }));
  parts.push(el.text(x + w - 20, meterY, `${Math.round(costRatio * 100)}%`, { size: 11.5, fill: C.sub, anchor: 'end' }));

  parts.push(el.text(x + 20, meterY + 26, '营养得分', { size: 11.5, fill: C.sub }));
  parts.push(el.bar(x + 100, meterY + 17, meterW - 80, 10, plan.score / 100, { fill: C.good }));
  parts.push(el.text(x + w - 20, meterY + 26, `${plan.score}/100`, { size: 11.5, fill: C.sub, anchor: 'end' }));

  // 达标情况
  const checkY = meterY + 54;
  const checks = [
    ['热量达标', plan.checks.kcalInRange],
    ['蛋白达标', plan.checks.proteinMet],
    ['钠未超标', plan.checks.sodiumOk],
    ['脂肪未超标', plan.checks.fatOk],
  ];
  let cx = x + 20;
  for (const [label, ok] of checks) {
    const mark = ok === true ? '✓ ' : ok === false ? '✗ ' : '? ';
    const fill = ok === true ? C.good : ok === false ? C.bad : C.sub;
    parts.push(el.text(cx, checkY, mark + label + (ok === null ? '（未知）' : ''), { size: 12, fill }));
    cx += displayWidth(mark + label + (ok === null ? '（未知）' : '')) * 6 + 16;
  }

  parts.push(el.text(x + 20, y + h - 12, planReason(plan, index, ctx.targets, ctx.basis), { size: 11.5, fill: C.sub }));

  return { markup: parts.join(''), height: h };
}

function drawParetoChart(plans, ctx) {
  const { x, y, w, h } = ctx;
  const parts = [el.rect(x, y, w, h, { rx: 12, fill: '#FAFAFA', stroke: C.line, sw: 1 })];
  parts.push(el.text(x + 20, y + 28, '帕累托前沿：多花一块钱，能换回多少营养分', { size: 15, weight: 700, fill: C.ink }));

  const plot = { x: x + 62, y: y + 52, w: w - 110, h: h - 108 };
  const costs = plans.map((p) => payableFenOf(p) / 100);
  const scores = plans.map((p) => p.score);
  const minCost = Math.min(...costs, 0);
  const maxCost = Math.max(...costs, minCost + 1);
  const minScore = Math.min(...scores, 0);
  const maxScore = Math.max(...scores, minScore + 1);

  const sx = (cost) => plot.x + ((cost - minCost) / (maxCost - minCost || 1)) * plot.w;
  const sy = (score) => plot.y + plot.h - ((score - minScore) / (maxScore - minScore || 1)) * plot.h;

  // 网格
  for (let i = 0; i <= 4; i += 1) {
    const gy = plot.y + (plot.h / 4) * i;
    const value = Math.round(maxScore - ((maxScore - minScore) / 4) * i);
    parts.push(el.line(plot.x, gy, plot.x + plot.w, gy, { stroke: '#EDEDED' }));
    parts.push(el.text(plot.x - 10, gy + 4, String(value), { size: 11, fill: C.sub, anchor: 'end' }));
  }
  for (let i = 0; i <= 4; i += 1) {
    const gx = plot.x + (plot.w / 4) * i;
    const value = (minCost + ((maxCost - minCost) / 4) * i).toFixed(1);
    parts.push(el.line(gx, plot.y, gx, plot.y + plot.h, { stroke: '#F5F5F5' }));
    parts.push(el.text(gx, plot.y + plot.h + 20, `¥${value}`, { size: 11, fill: C.sub, anchor: 'middle' }));
  }
  parts.push(el.text(plot.x + plot.w / 2, plot.y + plot.h + 42, '券后实付（元）；预算按券前菜单价', { size: 12, fill: C.sub, anchor: 'middle' }));
  parts.push(el.text(x + 16, plot.y + 10, '营养得分', { size: 12, fill: C.sub }));

  // 预算线（预算为券前菜单价口径，故与横轴的券后实付不同口径）
  if (ctx.budgetFen) {
    const bx = sx(ctx.budgetFen / 100);
    if (bx >= plot.x && bx <= plot.x + plot.w) {
      parts.push(el.line(bx, plot.y, bx, plot.y + plot.h, { stroke: C.bad, sw: 1.5, dash: '5 4' }));
      parts.push(el.text(bx + 6, plot.y + 14, '预算上限', { size: 11, fill: C.bad }));
    }
  }

  // 全部可行解
  for (const plan of plans) {
    parts.push(el.circle(sx(payableFenOf(plan) / 100), sy(plan.score), 3, { fill: C.chart, opacity: 0.35 }));
  }

  // 前沿连线 + 推荐点
  const front = [...ctx.pareto].sort((a, b) => payableFenOf(a) - payableFenOf(b));
  for (let i = 1; i < front.length; i += 1) {
    parts.push(el.line(
      sx(payableFenOf(front[i - 1]) / 100), sy(front[i - 1].score),
      sx(payableFenOf(front[i]) / 100), sy(front[i].score),
      { stroke: C.red, sw: 2 },
    ));
  }
  for (const plan of front) {
    parts.push(el.circle(sx(payableFenOf(plan) / 100), sy(plan.score), 4.5, { fill: C.red }));
  }

  ctx.recommendations.forEach((plan, index) => {
    const px = sx(payableFenOf(plan) / 100);
    const py = sy(plan.score);
    parts.push(el.circle(px, py, 8, { fill: 'none', stroke: C.red, sw: 2, opacity: 0.9 }));
    parts.push(el.text(px, py - 14, planTitle(plan, index), { size: 12, weight: 700, fill: C.red, anchor: 'middle' }));
  });

  return { markup: parts.join(''), height: h };
}

/**
 * 渲染整张战报。
 * @param {object} result 求解结果 + 元信息
 * @returns {string} SVG 文本
 */
export function renderReport(result) {
  const {
    meta,
    targets,
    budgetFen,
    recommendations = [],
    pareto = [],
    plans = [],
    stats = {},
    coverage = {},
    dataNotes = [],
    coupons = [],
    priceVerification = null,
  } = result;

  const W = 1240;
  const PAD = 32;
  const colW = (W - PAD * 2 - 24) / 2;

  const chunks = [];
  let y = 0;

  // ---- 页头
  const headerH = 132;
  chunks.push(el.rect(0, 0, W, headerH, { fill: C.red }));
  chunks.push(el.rect(0, headerH - 10, W, 10, { fill: C.yellow }));
  chunks.push(el.text(PAD, 58, '麦麦双赢 · 配餐战报', { size: 30, weight: 800, fill: '#FFFFFF' }));
  chunks.push(el.text(PAD, 86, '预算与营养的双目标最优解 —— 由麦当劳中国 MCP 实时数据算出', { size: 14, fill: '#FFE9E7' }));

  const modeLabel = meta.mode === 'live' ? '实时数据（官方 MCP）' : '演示数据（离线示例，非官方实时结果）';
  chunks.push(el.rect(W - PAD - 250, 34, 250, 30, { rx: 15, fill: meta.mode === 'live' ? '#1E7F3C' : '#7A4B00' }));
  chunks.push(el.text(W - PAD - 125, 54, modeLabel, { size: 12.5, weight: 600, fill: '#FFFFFF', anchor: 'middle' }));

  chunks.push(el.text(PAD, 112, `门店：${meta.store?.name ?? '—'}${meta.store?.code ? `（${meta.store.code}）` : ''}　|　生成时间：${meta.generatedAt}　|　预算：¥${yuan(budgetFen)}`,
    { size: 12.5, fill: '#FFD9D6' }));

  y = headerH + 28;

  // ---- 目标口径
  const goalH = 76;
  chunks.push(el.rect(PAD, y, W - PAD * 2, goalH, { rx: 10, fill: '#F7F7F7', stroke: C.line, sw: 1 }));
  const goalText = [
    `热量目标 ${targets.kcal} kcal（容差 ±${Math.round((targets.kcalTolerance ?? 0.2) * 100)}%）`,
    `蛋白质 ≥ ${targets.proteinG} g`,
    `钠 ≤ ${targets.sodiumMaxMg} mg`,
    `营养合格门槛 ≥ ${stats.minScore ?? 70} 分`,
  ];
  let gx = PAD + 20;
  for (const text of goalText) {
    chunks.push(el.text(gx, y + 32, text, { size: 13, weight: 600, fill: C.ink }));
    gx += displayWidth(text) * 6.6 + 26;
  }
  chunks.push(el.text(PAD + 20, y + 56,
    `搜索空间：菜单 ${coverage.menuTotal ?? '—'} 项 → 候选 ${stats.candidateCount ?? '—'} 项 → 枚举 ${stats.totalPlans ?? '—'} 个方案 → 预算内 ${stats.withinBudget ?? '—'} 个 → 达标 ${stats.qualifying ?? '—'} 个（裁剪后枚举，非全量穷举`
    + `${stats.perCategoryAdjusted ? `；候选规模已自动下调 ${stats.perCategoryAdjusted.requested}→${stats.perCategoryAdjusted.used} 以避免搜索截断` : ''}`
    + `${stats.truncated ? '；⚠ 已达方案数上限被截断' : ''}`
    + `${stats.qualifyingBasis === 'score-fallback' ? '；⚠ 无方案满足全部硬目标，「达标」已退化为得分门槛' : ''}）`,
    { size: 11.5, fill: C.sub }));
  y += goalH + 24;

  // ---- 方案卡片
  // 注意：卡片必须逐张累加 y 后绘制。否则三张卡片会画在同一个 y 上互相覆盖
  // （只看得见最后一张），而总高度却按三张算，留下大片空白。
  const cardMarkup = recommendations.map((plan, index) => {
    const res = drawPlanCard(plan, index, { x: PAD, y, w: W - PAD * 2, budgetFen, targets, minScore: stats.minScore ?? 70, basis: stats.qualifyingBasis });
    y += res.height + (index === recommendations.length - 1 ? 24 : 14);
    return res.markup;
  });
  chunks.push(cardMarkup.join(''));

  // ---- 帕累托图
  const chart = drawParetoChart(plans, {
    x: PAD, y, w: W - PAD * 2, h: 300, pareto, recommendations, budgetFen,
  });
  chunks.push(chart.markup);
  y += chart.height + 24;

  // ---- 可用优惠券（仅用于估算，不自动领取）
  if (coupons.length) {
    const rows = coupons.slice(0, 8);
    const boxH = 34 + rows.length * 22 + 16;
    chunks.push(el.rect(PAD, y, W - PAD * 2, boxH, { rx: 10, fill: '#FFFFFF', stroke: C.line, sw: 1 }));
    chunks.push(el.text(PAD + 20, y + 26, `可用优惠券 ${coupons.length} 张（可量化者已纳入方案择优，按券后实付排序；本项目不会自动领券）`,
      { size: 14, weight: 700, fill: C.ink }));
    let cy = y + 50;
    const describeCoupon = (c) => {
      if (c.usable) {
        if ((c.couponPriceFen ?? 0) > 0) {
          return `指定商品用券价 ¥${yuan(c.couponPriceFen)}（已定位商品 ${c.appliesToCode}，计入优惠）`;
        }
        return `${c.thresholdFen ? `满 ¥${yuan(c.thresholdFen)} ` : '无门槛 '}减 ¥${yuan(c.discountFen)}（计入优惠）`;
      }
      return `${c.excludedReason ?? '面额/规则无法量化'}，不计入优惠`;
    };
    for (const c of rows) {
      chunks.push(el.text(PAD + 20, cy, `${c.name ?? c.id}　${describeCoupon(c)}${c.source ? `　来源：${c.source}` : ''}`,
        { size: 12, fill: C.ink }));
      cy += 22;
    }
    if (coupons.length > rows.length) {
      chunks.push(el.text(PAD + 20, cy, `…… 另有 ${coupons.length - rows.length} 张未逐一列出（估算法仍会考虑）。`, { size: 11.5, fill: C.sub }));
    }
    y += boxH + 24;
  }

  // ---- 官方验价
  if (priceVerification && (priceVerification.verified?.length || priceVerification.failures?.length)) {
    const boxH = 34 + (priceVerification.verified.length + priceVerification.failures.length) * 22 + 16;
    chunks.push(el.rect(PAD, y, W - PAD * 2, boxH, { rx: 10, fill: '#FFFFFF', stroke: C.line, sw: 1 }));
    chunks.push(el.text(PAD + 20, y + 26, '官方算价核验（calculate-price）', { size: 14, weight: 700, fill: C.ink }));
    let ly = y + 50;
    for (const row of priceVerification.verified) {
      const delta = row.localFen !== null && row.officialFen !== null ? row.officialFen - row.localFen : null;
      const deltaText = delta === null ? '无法比较' : delta === 0 ? '与本地菜单价一致' : `相差 ${delta > 0 ? '+' : ''}${yuan(delta)} 元`;
      const couponText = row.couponName
        ? `　使用券「${row.couponName}」${row.discountFen ? `，券面优惠 ¥${yuan(row.discountFen)}` : ''}`
        : '　未使用优惠券';
      const localText = row.localPayableFen !== undefined && row.localPayableFen !== row.localFen
        ? `本地菜单价 ¥${yuan(row.localFen)}（估算券后 ¥${yuan(row.localPayableFen)}）`
        : `本地菜单价 ¥${yuan(row.localFen)}`;
      chunks.push(el.text(PAD + 20, ly, `#${row.index + 1} ${row.label}：${localText} → 官方 ¥${yuan(row.officialFen)}（${deltaText}）`,
        { size: 12, fill: C.ink }));
      chunks.push(el.text(PAD + 640, ly, couponText, { size: 11.5, fill: C.sub }));
      ly += 22;
    }
    for (const row of priceVerification.failures) {
      chunks.push(el.text(PAD + 20, ly, `#${row.index + 1} ${row.label}：验价失败 —— ${row.reason}`, { size: 12, fill: C.bad }));
      ly += 22;
    }
    y += boxH + 24;
  }

  // ---- 数据说明与免责
  const notes = [
    // 搜索被截断时必须显式告警：否则会把"被砍断的搜索结果"当成完整最优解展示出去
    ...(stats.truncated
      ? [`⚠️ 搜索已被截断：候选组合数达到上限（${stats.totalPlans} 个方案），本次结果基于「部分」枚举，可能不是全局最优。请调小 --per-category 后重跑。`]
      : []),
    '「达标」判定：热量落在目标区间内、蛋白质不低于下限、钠不超过上限 —— 三项全部满足才算达标（不用复合得分代替硬目标）。',
    `数据来源：麦当劳中国 MCP Server（${meta.endpoint ?? 'https://mcp.mcd.cn'}），工具：${(meta.toolsUsed ?? []).join('、') || '—'}`,
    `营养覆盖：菜单 ${coverage.menuTotal ?? '—'} 项中 ${coverage.matched ?? '—'} 项匹配到${meta.mode === 'live' ? '官方营养数据' : '演示营养数据'}，${coverage.unmatched ?? '—'} 项未匹配（未匹配项不参与优化，避免用猜测值计算）。`,
    ...dataNotes,
    '本项目为「麦当劳程序员创意开发大赛」参赛作品，非麦当劳官方产品；餐品信息、价格与供应状态请以麦当劳官方渠道实时结果为准。',
    '本战报不构成医疗、营养或任何专业建议。',
  ];
  const noteLineCount = notes.reduce((sum, n) => sum + wrapText(n, 128).length, 0);
  const notesH = 44 + noteLineCount * 20 + 16;
  chunks.push(el.rect(PAD, y, W - PAD * 2, notesH, { rx: 10, fill: '#FBFBFB', stroke: C.line, sw: 1 }));
  chunks.push(el.text(PAD + 20, y + 28, '数据口径与说明', { size: 14, weight: 700, fill: C.ink }));
  let ny = y + 50;
  for (const note of notes) {
    const lines = wrapText(note, 128);
    lines.forEach((line, i) => {
      chunks.push(el.text(PAD + 20, ny, (i === 0 ? '· ' : '  ') + line, { size: 11.5, fill: C.sub }));
      ny += 20;
    });
  }
  y += notesH + 28;

  const totalH = y;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}" role="img" aria-label="麦麦双赢配餐战报">
<rect width="${W}" height="${totalH}" fill="${C.bg}"/>
${chunks.join('\n')}
</svg>
`;
}

export const REPORT_COLORS = C;
