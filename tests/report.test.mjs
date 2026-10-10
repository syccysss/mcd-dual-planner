import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReport, displayWidth, wrapText, escapeXml } from '../src/report.mjs';
import { buildPlanDemo } from '../src/pipeline.mjs';

test('显示宽度：CJK 记 2，ASCII 记 1', () => {
  assert.equal(displayWidth('巨无霸'), 6);
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('巨无霸abc'), 9);
  assert.equal(displayWidth(''), 0);
});

test('折行：按显示宽度切分，长文本不丢字', () => {
  assert.deepEqual(wrapText('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrapText('中文测试', 4), ['中文', '测试']);
  assert.deepEqual(wrapText('ab中文', 4), ['ab中', '文']);
  assert.equal(wrapText('中文测试很长的一段文字内容', 6).join(''), '中文测试很长的一段文字内容');
  assert.deepEqual(wrapText('', 10), ['']);
});

test('XML 转义：& < > " 全部处理', () => {
  assert.equal(escapeXml('A & B < C > D " E'), 'A &amp; B &lt; C &gt; D &quot; E');
});

test('渲染战报：包含画布、模式徽标与方案卡片', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  const svg = renderReport(result);
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('麦麦双赢 · 配餐战报'));
  assert.ok(svg.includes('演示数据'), '演示模式下必须显著标注演示数据');
  assert.ok(svg.includes('帕累托前沿'));
  assert.ok(svg.includes('双赢推荐'));
  assert.ok(svg.includes('数据口径与说明'));
});

test('渲染战报：数据口径里写明「达标」的判定口径', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  const svg = renderReport(result);
  assert.ok(svg.includes('三项全部满足才算达标'), '必须说明达标=硬目标全满足');
});

test('渲染战报：搜索被截断时必须显式告警，不能把部分枚举当完整最优解', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  result.stats.truncated = true;
  const svg = renderReport(result);
  assert.ok(svg.includes('截断'), '战报必须出现截断告警');
  assert.ok(svg.includes('可能不是全局最优'));
});

test('渲染战报：门店名里的特殊字符被正确转义，不会破坏 SVG 结构', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  result.meta.store = { name: 'A & B <危险> "店"', code: 'X1' };
  const svg = renderReport(result);
  assert.ok(svg.includes('A &amp; B &lt;危险&gt; &quot;店&quot;'));
  assert.ok(!svg.includes('<危险>'));
});

test('渲染战报：标签成对闭合（结构性自检）', () => {
  const svg = renderReport(buildPlanDemo({ budgetYuan: 30 }));
  const opens = (svg.match(/<text[\s>]/g) ?? []).length;
  const closes = (svg.match(/<\/text>/g) ?? []).length;
  assert.equal(opens, closes, '<text> 标签必须成对');
  const rectOpens = (svg.match(/<rect[\s>]/g) ?? []).length;
  assert.ok(rectOpens > 10);
  assert.ok(!svg.includes('undefined'), 'SVG 中不应出现 undefined');
  assert.ok(!svg.includes('NaN'), 'SVG 中不应出现 NaN');
});

test('渲染战报：实时模式下徽标改为实时数据', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  result.meta.mode = 'live';
  result.meta.endpoint = 'https://mcp.mcd.cn';
  result.meta.toolsUsed = ['query-meals', 'list-nutrition-foods'];
  result.priceVerification = {
    verified: [{ index: 0, label: '双赢推荐', localFen: 2350, officialFen: 2380, discountFen: 500, couponName: '满30减5' }],
    failures: [{ index: 1, label: '营养上限', reason: '参数不匹配' }],
  };
  const svg = renderReport(result);
  assert.ok(svg.includes('实时数据（官方 MCP）'));
  assert.ok(svg.includes('官方算价核验'));
  assert.ok(svg.includes('满30减5'));
  assert.ok(svg.includes('验价失败'));
});

test('渲染战报：达标口径退化时，双赢推荐不得声称「满足全部硬目标」', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  assert.ok(result.recommendations.some((r) => r.kind === 'valueBest'));
  result.stats.qualifyingBasis = 'score-fallback';
  const svg = renderReport(result);
  assert.ok(svg.includes('没有方案完全满足硬目标'), '退化时必须如实说明，不能把不达标的说成达标');
  assert.ok(svg.includes('已退化为得分门槛'), '战报必须显式标注达标口径已退化');
});

test('渲染战报：候选规模被自动下调以避免截断时必须留痕', () => {
  const result = buildPlanDemo({ budgetYuan: 30 });
  result.stats.perCategoryAdjusted = { requested: 6, used: 5, reason: '为避免搜索截断已自动下调' };
  const svg = renderReport(result);
  assert.ok(svg.includes('候选规模已自动下调'), '必须说明候选规模被调整过');
  assert.ok(svg.includes('6→5'), '必须给出调整前后的具体数值');
});
