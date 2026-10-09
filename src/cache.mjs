/**
 * 菜单与算价结果的本地文件缓存
 * ---------------------------------------------------------------
 * 为什么需要缓存：
 *   官方 query-meals 不返回名称与价格，必须逐品调用 calculate-price 补齐，
 *   116 品门店一次求解约 140 次请求、20 秒。菜单在 30 分钟内基本不变，
 *   缓存后二次求解降到个位数请求、秒出结果。
 *
 * 边界：
 *   - 缓存只存餐品名称/价格/品类（公开营业数据），不含 Token、不含个人信息；
 *   - 读失败或过期一律视为未命中，绝不因缓存损坏而影响主流程；
 *   - 写入采用「临时文件 + rename」原子替换，避免写一半留下坏文件。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DIR = join(homedir(), '.mcd-dual');
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function cacheFilePath() {
  return process.env.MCD_CACHE_FILE ?? join(DEFAULT_DIR, 'cache.json');
}

function cacheKey({ storeCode, beType = 1, orderType = 1 }) {
  return `${storeCode}|${beType}|${orderType}`;
}

async function readAll(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

/**
 * 读缓存。命中返回 {menu, pricingFailed, savedAt}，否则 null。
 */
export async function cacheLoad(keyParams, { ttlMs = DEFAULT_TTL_MS, path = cacheFilePath() } = {}) {
  const key = cacheKey(keyParams);
  const all = await readAll(path);
  const entry = all.entries[key];
  if (!entry?.menu?.length || !entry.savedAt) return null;
  if (Date.now() - entry.savedAt > ttlMs) return null;
  return { menu: entry.menu, pricingFailed: entry.pricingFailed ?? 0, savedAt: entry.savedAt };
}

/**
 * 写缓存（原子替换）。
 */
export async function cacheSave(keyParams, { menu, pricingFailed = 0, path = cacheFilePath() } = {}) {
  const key = cacheKey(keyParams);
  const all = await readAll(path);
  all.entries[key] = { savedAt: Date.now(), menu, pricingFailed };
  const target = path;
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
  await rename(tmp, target).catch(async () => {
    // Windows 上 rename 覆盖已存在文件偶尔失败，退化为直接写
    await writeFile(target, JSON.stringify(all, null, 2), 'utf8');
  });
}
