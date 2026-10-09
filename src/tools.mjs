/**
 * 麦当劳 MCP 工具适配层
 * ---------------------------------------------------------------
 * 职责：把"我想做什么"翻译成"官方工具的实际参数名"。
 *
 * 为什么需要适配而不是硬编码参数：
 *  官方工具的参数名会随版本演进（例如门店编码在不同工具里是 beCode / storeCode），
 *  与其把猜测写死在代码里，不如在运行时读取 tools/list 返回的 inputSchema，
 *  按名称归一化（忽略大小写与下划线）去匹配真实参数名，匹配不上就如实报告。
 *
 * 安全边界（本项目的硬约束）：
 *  只调用**只读**工具。create-order / mall-create-order / draw-lottery 等会写入
 *  账户或产生扣款的能力，本项目一律不调用 —— 战报只做"算什么"，不做"下单"。
 */

/** 归一化参数名用于模糊匹配 */
const norm = (s) => String(s).toLowerCase().replace(/[_\-\s]/g, '');

/** 本项目允许调用的只读工具白名单（写操作一律不在列） */
export const READ_ONLY_TOOLS = new Set([
  'now-time-info',
  'query-nearby-stores',
  'delivery-query-stores',
  'delivery-query-addresses',
  'query-meals',
  'query-meal-detail',
  'list-nutrition-foods',
  'query-store-coupons',
  'available-coupons',
  'query-my-coupons',
  'query-my-account',
  'campaign-calendar',
  'calculate-price',
]);

/** 明确禁止调用的写操作（出现即报错，防止误用） */
export const WRITE_TOOLS = new Set([
  'create-order', 'cancel-order', 'auto-bind-coupons', 'mall-create-order',
  'draw-lottery', 'party-order-create', 'delivery-create-address',
]);

/**
 * 按 inputSchema 把期望参数映射为真实参数名。
 * @returns {{args: object, unmatched: string[], usedSchema: boolean}}
 */
export function buildArgs(tool, desired) {
  const props = tool?.inputSchema?.properties;
  if (!props || typeof props !== 'object' || Object.keys(props).length === 0) {
    // 拿不到 schema（部分工具无 inputSchema）时按原样传参，由服务端校验
    return { args: { ...desired }, unmatched: [], usedSchema: false };
  }

  const propKeys = Object.keys(props);
  const args = {};
  const unmatched = [];

  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined || value === null) continue;
    if (props[key]) {
      args[key] = value;
      continue;
    }
    const hit = propKeys.find((k) => norm(k) === norm(key));
    if (hit) {
      args[hit] = value;
    } else {
      unmatched.push(key);
    }
  }
  return { args, unmatched, usedSchema: true };
}

/** 从工具 schema 里找出"看起来像门店编码"的真实参数名 */
export function guessParam(tool, candidates) {
  const props = tool?.inputSchema?.properties;
  if (!props || Object.keys(props).length === 0) return candidates[0] ?? null;
  const keys = Object.keys(props);
  for (const candidate of candidates) {
    const hit = keys.find((k) => norm(k) === norm(candidate));
    if (hit) return hit;
  }
  return null;
}

/**
 * 分组映射参数：每组给出若干候选名，取 schema 中真实存在的第一个。
 * 这样即使官方把 cityName 改名成 city，代码也不用改。
 * @param {object} tool 工具 schema
 * @param {Array<{keys: string[], value: any}>} groups
 */
export function mapParams(tool, groups) {
  const args = {};
  const unmatched = [];
  for (const group of groups) {
    if (group.value === undefined || group.value === null) continue;
    const realKey = guessParam(tool, group.keys);
    if (realKey) args[realKey] = group.value;
    else unmatched.push(group.keys[0]);
  }
  return { args, unmatched };
}

export class ToolRegistry {
  #client;
  #tools = new Map();
  #log = [];
  #allowWrite = false;

  constructor(client, { onLog } = {}) {
    this.#client = client;
    this.onLog = onLog ?? (() => {});
  }

  async load() {
    const tools = await this.#client.listTools();
    this.#tools = new Map(tools.map((t) => [t.name, t]));
    return this.#tools;
  }

  names() {
    return [...this.#tools.keys()];
  }

  has(name) {
    return this.#tools.has(name);
  }

  schema(name) {
    return this.#tools.get(name) ?? null;
  }

  /** 只读调用入口：越界即抛错，绝不静默放行 */
  async call(name, desired = {}) {
    if (WRITE_TOOLS.has(name)) {
      throw new Error(`拒绝调用写操作工具 ${name}：本项目只做只读测算，不会下单或扣款。`);
    }
    if (!this.#allowWrite && !READ_ONLY_TOOLS.has(name)) {
      throw new Error(`工具 ${name} 不在只读白名单内，已拒绝调用。如确需使用请在白名单中显式登记。`);
    }
    if (!this.#tools.has(name)) {
      throw new Error(`当前 MCP 服务未暴露工具 ${name}（可能是版本差异）。`);
    }

    const tool = this.#tools.get(name);
    const { args, unmatched, usedSchema } = buildArgs(tool, desired);
    const startedAt = Date.now();
    const result = await this.#client.callTool(name, args);
    this.#log.push({
      tool: name,
      args: Object.keys(args),
      unmatched,
      usedSchema,
      ms: Date.now() - startedAt,
      isError: result.isError,
    });
    this.onLog(this.#log[this.#log.length - 1]);
    return result;
  }

  get callLog() {
    return [...this.#log];
  }
}

/** 工具调用统计，写进战报的数据来源说明 */
export function summarizeCalls(callLog) {
  const byTool = new Map();
  for (const entry of callLog) byTool.set(entry.tool, (byTool.get(entry.tool) ?? 0) + 1);
  return {
    total: callLog.length,
    byTool: [...byTool.entries()].map(([tool, count]) => ({ tool, count })),
    unmatchedParams: [...new Set(callLog.flatMap((e) => e.unmatched))],
    errors: callLog.filter((e) => e.isError).length,
  };
}
