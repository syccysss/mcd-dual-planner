#!/usr/bin/env node
/**
 * 多城市 × 多门店 批量验证器
 * ---------------------------------------------------------------
 * 为什么单独写它：
 *   单店验证只能证明「算法在某一家门店的数据上跑得通」，不能证明它在
 *   全国不同价格体系、不同菜单、不同券环境下依然可靠。本项目对外承诺
 *   「按你所在门店的实时数据算」，那就必须跨城市交叉验证：
 *   同一份代码、换一家门店，结论是否依然可信、验价是否依然一致。
 *
 * 用法（城市用拼音，避免 Windows 终端中文编码问题）：
 *   node tools/batch-verify.mjs
 *   node tools/batch-verify.mjs --cities beijing,shanghai,guangzhou
 *   node tools/batch-verify.mjs --cities chengdu --per-city 3      # 同城多店
 *   node tools/batch-verify.mjs --cities beijing --budget 20       # 收紧预算
 *   node tools/batch-verify.mjs --cities chengdu --be-type 5       # 得来速车道取餐
 *   node tools/batch-verify.mjs --be-type 2                        # 麦乐送（按账号配送地址分站）
 *
 * 产物（均可安全分享，Token 不会落盘；外送场景亦不落盘任何收货信息）：
 *   examples/stores/<门店编码>.json    每店原始快照（菜单/营养/券/匹配）
 *   examples/batch-summary.json        跨店汇总（含跨城同款商品价格对比）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient, McpError, DEFAULT_ENDPOINT } from '../src/mcp-client.mjs';
import { ToolRegistry, mapParams, summarizeCalls } from '../src/tools.mjs';
import { buildPlanLive, resolveStores } from '../src/pipeline.mjs';
import { normalizeStores, normalizeAddresses } from '../src/normalize.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 城市预设：拼音 -> 中文城市名 + 一个便于命中的地标关键词 */
const CITY_PRESETS = {
  beijing: { city: '北京', keyword: '王府井' },
  shanghai: { city: '上海', keyword: '南京东路' },
  guangzhou: { city: '广州', keyword: '天河城' },
  shenzhen: { city: '深圳', keyword: '华强北' },
  chengdu: { city: '成都', keyword: '春熙路' },
  hangzhou: { city: '杭州', keyword: '武林广场' },
  xian: { city: '西安', keyword: '钟楼' },
  wuhan: { city: '武汉', keyword: '光谷' },
  nanjing: { city: '南京', keyword: '新街口' },
  chongqing: { city: '重庆', keyword: '解放碑' },
};
const DEFAULT_CITIES = 'beijing,shanghai,guangzhou,shenzhen,chengdu,hangzhou,xian,wuhan';

const KIND_LABELS = { valueBest: '双赢推荐', topScore: '营养上限', cheapest: '省钱底线' };

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else { options[key] = next; i += 1; }
    }
  }
  return options;
}

function resolveCity(key) {
  const k = String(key).trim();
  if (!k) return null;
  if (CITY_PRESETS[k]) return { key: k, ...CITY_PRESETS[k] };
  // 也允许直接写中文城市名
  return { key: k, city: k, keyword: k };
}

/**
 * 定位门店。
 *  - 外送（beType 2/6）：复用 pipeline 的 resolveStores，走「账号配送地址 → 可配送门店」，
 *    与实时求解完全同一套逻辑，避免两处口径漂移。
 *  - 到店/得来速（beType 1/5）：城市 + 地标关键词，关键词命中为空时退回只按城市。
 */
async function findStores(registry, station, beType) {
  if (beType === 2 || beType === 6) {
    const { stores } = await resolveStores(registry, { beType, addressId: station.addressId });
    return stores;
  }

  const tool = registry.schema('query-nearby-stores');
  if (!tool) throw new Error('未暴露 query-nearby-stores');

  // 注意：官方真实参数名是 city（不是 cityName），所以每个逻辑参数都要给出候选名列表，
  // 由 mapParams 按 schema 归一化匹配，否则城市会静默丢失、查不到任何门店。
  const attempts = [
    { searchType: 2, city: station.city, keyword: station.keyword, beType },
    { searchType: 2, city: station.city, beType },
  ];
  let lastError = null;
  for (const desired of attempts) {
    try {
      const { args } = mapParams(tool, [
        { keys: ['searchType'], value: desired.searchType },
        { keys: ['city', 'cityName', 'cityCode'], value: desired.city },
        { keys: ['keyword', 'storeName', 'storeKeyword', 'searchKey'], value: desired.keyword },
        { keys: ['beType'], value: desired.beType },
      ]);
      const res = await registry.call('query-nearby-stores', args);
      const stores = normalizeStores(res.data ?? res.raw);
      if (stores.length) return stores;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return [];
}

/** 把一次实时求解压缩成一行可比的指标 */
function summarize(result, cityInfo, store) {
  const s = result.stats ?? {};
  const pv = result.priceVerification ?? { verified: [], failures: [] };
  const verByIndex = new Map((pv.verified ?? []).map((v) => [v.index, v]));
  const menuTotal = result.coverage?.menuTotal ?? null;
  const matched = result.coverage?.matched ?? null;
  const payableOf = (r) => r.totals?.payableFen ?? r.payableFen ?? r.totals?.priceFen ?? null;

  return {
    city: cityInfo.city,
    storeCode: result.meta.store?.code ?? store.code,
    storeName: result.meta.store?.name ?? store.name,
    address: store.address ?? null,
    beType: result.meta.beType ?? null,
    orderType: result.meta.orderType ?? null,
    menuTotal,
    matched,
    unmatched: result.coverage?.unmatched ?? null,
    matchRate: menuTotal ? +(matched / menuTotal * 100).toFixed(0) : null,
    couponDeduped: result.coupons?.length ?? 0,
    couponUsable: (result.coupons ?? []).filter((c) => c.usable).length,
    candidates: s.candidateCount ?? null,
    enumerated: s.totalPlans ?? s.enumerated ?? null,
    truncated: s.truncated ?? null,
    withinBudget: s.withinBudget ?? null,
    qualifying: s.qualifying ?? null,
    qualifyingBasis: s.qualifyingBasis ?? null,
    // 候选规模是否被引擎自动下调过（下调是为了避免"枚举到一半砍断"造成的结果偏差）
    perCategoryRequested: s.perCategoryAdjusted?.requested ?? s.perCategory ?? null,
    perCategoryUsed: s.perCategoryAdjusted?.used ?? s.perCategory ?? null,
    perCategoryAdjusted: Boolean(s.perCategoryAdjusted),
    pareto: result.pareto?.length ?? null,
    recs: (result.recommendations ?? []).map((r, i) => {
      const v = verByIndex.get(i);
      const payableFen = payableOf(r);
      return {
        kind: r.kind,
        label: KIND_LABELS[r.kind] ?? r.kind,
        priceYuan: r.totals?.priceFen != null ? +(r.totals.priceFen / 100).toFixed(2) : null,
        payableYuan: payableFen != null ? +(payableFen / 100).toFixed(2) : null,
        score: r.score ?? null,
        kcal: r.totals?.energyKcal ?? null,
        proteinG: r.totals?.proteinG ?? null,
        sodiumMg: r.totals?.sodiumMg ?? null,
        couponName: v?.couponName ?? null,
        verified: v ? v.officialFen === v.localFen : null,
        officialYuan: v?.officialFen != null ? +(v.officialFen / 100).toFixed(2) : null,
        // 外送场景：官方到手价（含配送费 + 打包费），与"餐品价"区分开
        deliveredYuan: v?.officialTotalFen != null && v.officialTotalFen !== v.officialFen
          ? +(v.officialTotalFen / 100).toFixed(2) : null,
        deliveryFeeYuan: v?.deliveryFen != null ? +(v.deliveryFen / 100).toFixed(2) : null,
        packingFeeYuan: v?.packingFen != null ? +(v.packingFen / 100).toFixed(2) : null,
        items: (r.items ?? []).map((x) => x.name),
      };
    }),
    verifyFailures: (pv.failures ?? []).map((f) => `${f.label}: ${f.reason}`),
  };
}

/** 跨城同款商品（同一 productCode）的价格对比 —— 用来证明「价格随门店变、必须实时取」 */
function crossCityPrices(menus, rows) {
  const cityOf = new Map(rows.filter((r) => r.storeCode).map((r) => [r.storeCode, r.city]));
  const byCode = new Map();
  for (const [storeCode, menu] of menus) {
    for (const m of menu ?? []) {
      if (m.code == null || m.priceFen == null) continue;
      if (!byCode.has(m.code)) byCode.set(m.code, []);
      byCode.get(m.code).push({ store: storeCode, city: cityOf.get(storeCode), name: m.name, priceYuan: +(m.priceFen / 100).toFixed(2) });
    }
  }
  const comparable = [];
  const diffs = [];
  for (const [code, list] of byCode) {
    if (list.length < 2) continue;
    comparable.push(code);
    const prices = list.map((x) => x.priceYuan);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (max > min) diffs.push({ code, name: list[0].name, min, max, diff: +(max - min).toFixed(2), stores: list });
  }
  diffs.sort((a, b) => b.diff - a.diff);
  return { comparableItems: comparable.length, differingItems: diffs.length, top: diffs.slice(0, 25) };
}

function logRow(row) {
  const recs = row.recs.map((r) => `${r.label} ¥${r.payableYuan}(${r.score}分/${r.proteinG}g蛋白)`
    + (r.deliveredYuan != null ? `[到手¥${r.deliveredYuan}]` : '')).join(' | ');
  console.log(`  ✓ ${row.city} / ${row.storeName}（${row.storeCode}）`
    + `　beType=${row.beType}/orderType=${row.orderType}`
    + `\n      菜单 ${row.menuTotal} · 营养 ${row.matched}(${row.matchRate}%) · 券 ${row.couponDeduped}(可用${row.couponUsable})`
    + ` · 候选 ${row.candidates} · 枚举 ${row.enumerated}${row.truncated ? '【截断】' : ''}`
    + `${row.perCategoryAdjusted ? `【候选规模自动 ${row.perCategoryRequested}→${row.perCategoryUsed}】` : ''}`
    + ` · 预算内 ${row.withinBudget} · 达标 ${row.qualifying}(${row.qualifyingBasis}) · 帕累托 ${row.pareto}`
    + `\n      ${recs || '（无推荐）'}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) {
    console.error('缺少环境变量 MCD_MCP_TOKEN。');
    process.exit(1);
  }

  const cities = String(options.cities ?? DEFAULT_CITIES).split(',').map(resolveCity).filter(Boolean);
  const perCity = Math.max(1, Number(options['per-city'] ?? 1));
  const budgetYuan = Number(options.budget ?? 40);
  const beType = Number(options['be-type'] ?? 1);
  const outDir = resolve(ROOT, String(options.out ?? 'examples/stores'));
  const summaryPath = resolve(ROOT, String(options.summary ?? 'examples/batch-summary.json'));

  const client = new McpClient({
    endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
    token,
    minIntervalMs: Number(options['min-interval-ms'] ?? 120),
    timeoutMs: Number(options['timeout-ms'] ?? 30_000),
  });
  const registry = new ToolRegistry(client);
  await registry.load();
  await mkdir(outDir, { recursive: true });

  const rows = [];
  const menus = new Map();
  const startedAll = Date.now();

  // 到店/得来速按「城市」分站；外送按「配送地址」分站（地址属于账号，不属于城市）
  let stations = cities;
  if (beType === 2 || beType === 6) {
    const addrRes = await registry.call('delivery-query-addresses', {});
    const addresses = normalizeAddresses(addrRes.data ?? addrRes.raw);
    if (!addresses.length) {
      console.log('✗ 账号下没有可用配送地址，无法进行外送验证。');
      process.exit(1);
    }
    stations = addresses.map((a, i) => ({
      key: a.id,
      city: a.cityHint ?? `地址 #${i + 1}`,
      keyword: null,
      addressId: a.id,
    }));
    console.log(`外送场景（beType=${beType}）：账号下有 ${addresses.length} 个配送地址，逐地址验证可配送门店。`);
  }

  for (const cityInfo of stations) {
    console.log(`\n=== ${cityInfo.city}${cityInfo.keyword ? `（关键词：${cityInfo.keyword}）` : ''} ===`);
    let stores = [];
    try {
      stores = await findStores(registry, cityInfo, beType);
    } catch (err) {
      const msg = err instanceof McpError ? `${err.message}${err.hint ? ` / ${err.hint}` : ''}` : err.message;
      console.log(`  ✗ 门店查询失败：${msg}`);
      rows.push({ city: cityInfo.city, error: msg });
      continue;
    }
    if (!stores.length) {
      console.log('  ✗ 未查询到门店');
      rows.push({ city: cityInfo.city, error: '未查询到门店' });
      continue;
    }
    console.log(`  命中 ${stores.length} 家门店，取前 ${Math.min(perCity, stores.length)} 家`);

    for (const store of stores.slice(0, perCity)) {
      const t0 = Date.now();
      try {
        const result = await buildPlanLive(registry, {
          budgetYuan,
          city: cityInfo.city,
          // 必须把地标关键词一起带上：buildPlanLive 内部会重新查询门店，
          // 只给 city 不给 keyword 时官方可能返回空列表，导致找不到目标门店。
          storeKeyword: cityInfo.keyword,
          storeCode: store.code,
          addressId: cityInfo.addressId,
          beType,
          verify: true,
          cache: !options['no-cache'],
          comboLookupLimit: Number(options['combo-limit'] ?? 12),
          includeDataset: true,
        });
        const snapshot = {
          mode: result.meta.mode,
          city: cityInfo.city,
          store: result.meta.store,
          beType: result.meta.beType ?? null,
          orderType: result.meta.orderType ?? null,
          generatedAt: result.meta.generatedAt,
          targets: result.targets,
          budgetFen: result.budgetFen,
          menu: result.dataset.menu,
          nutrition: result.dataset.nutrition,
          matches: result.dataset.matches,
          coupons: result.coupons,
          dataNotes: result.dataNotes,
        };
        await writeFile(join(outDir, `${store.code}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        menus.set(String(store.code), result.dataset.menu);

        const row = summarize(result, cityInfo, store);
        row.elapsedMs = Date.now() - t0;
        row.requestCount = (result.meta.callStats?.total ?? null);
        rows.push(row);
        logRow(row);
      } catch (err) {
        const msg = err instanceof McpError ? `${err.message}${err.hint ? ` / ${err.hint}` : ''}` : err.message;
        console.log(`  ✗ ${store.name}（${store.code}）求解失败：${msg}`);
        rows.push({ city: cityInfo.city, storeCode: store.code, storeName: store.name, error: msg });
      }
    }
  }

  const okRows = rows.filter((r) => !r.error);
  const crossCity = crossCityPrices(menus, okRows);
  const summary = {
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    budgetYuan,
    beType,
    elapsedSec: Math.round((Date.now() - startedAll) / 1000),
    storeCount: okRows.length,
    rows,
    crossCity,
    callStats: summarizeCalls(registry.callLog),
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  // ---- 终端汇总 ----
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  多门店验证汇总：成功 ${okRows.length} / 尝试 ${rows.length} 家门店，用时 ${summary.elapsedSec}s`);
  console.log(`${'═'.repeat(72)}`);
  if (okRows.length) {
    console.log(`  营养匹配率：${okRows.map((r) => `${r.city} ${r.matchRate}%`).join(' · ')}`);
    console.log(`  达标(硬目标)：${okRows.map((r) => `${r.city} ${r.qualifying}`).join(' · ')}`);
    const truncs = okRows.filter((r) => r.truncated);
    console.log(`  搜索截断：${truncs.length ? truncs.map((r) => r.city).join('、') : '无（全部完整枚举）'}`);
    const verBad = okRows.flatMap((r) => r.recs.filter((x) => x.verified === false).map((x) => `${r.city}/${x.label}`));
    console.log(`  官方验价：${verBad.length ? `不一致 ${verBad.join('、')}` : '全部一致'}`);
    const failed = okRows.flatMap((r) => r.verifyFailures.map((f) => `${r.city} ${f}`));
    if (failed.length) console.log(`  验价失败：${failed.join(' | ')}`);
  }
  if (crossCity.comparableItems) {
    console.log(`\n  跨城同款商品价格：可比 ${crossCity.comparableItems} 款，其中 ${crossCity.differingItems} 款存在城市间价差`);
    for (const d of crossCity.top.slice(0, 8)) {
      console.log(`    ${d.name}：¥${d.min} ~ ¥${d.max}（差 ¥${d.diff}）  ${d.stores.map((s) => `${s.city}¥${s.priceYuan}`).join(' / ')}`);
    }
  }
  console.log(`\n  调用统计：${JSON.stringify(summary.callStats)}`);
  console.log(`  快照目录：${outDir}`);
  console.log(`  汇总文件：${summaryPath}`);
}

main().catch((err) => {
  const msg = err instanceof McpError ? `${err.message}${err.hint ? `\n提示：${err.hint}` : ''}` : (err?.stack ?? String(err));
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
});
