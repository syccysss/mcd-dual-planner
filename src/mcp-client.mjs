/**
 * 极简 MCP Streamable HTTP 客户端（零依赖）
 * ---------------------------------------------------------------
 * 只实现本项目需要的三个能力：initialize / tools.list / tools.call。
 * 设计取舍：
 *  1. 零第三方依赖 —— 评委和用户 git clone 后无需 npm install 即可运行。
 *  2. Token 安全 —— Token 只存在于实例私有字段，任何错误信息、日志、
 *     JSON 序列化输出都会被脱敏，绝不落盘。
 *  3. 主动限流 —— 官方限制 600 请求/分钟，客户端默认串行 + 最小间隔，
 *     宁可慢一点也不触发 429。
 *  4. 错误分类 —— 401/429/超时/协议错误分开抛出，便于 CLI 给出可操作提示。
 */
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';

/** 官方文档约定的协议版本与限流阈值 */
export const PROTOCOL_VERSION = '2025-06-18';
export const RATE_LIMIT_PER_MINUTE = 600;

const CLIENT_INFO = { name: 'mcd-dual-planner', version: '0.1.0' };
const DEFAULT_MIN_INTERVAL_MS = 120;
const DEFAULT_TIMEOUT_MS = 30_000;
const REDACTED = '[redacted]';

export class McpError extends Error {
  constructor(message, { kind = 'unknown', status = null, code = null, hint = '' } = {}) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** 把上游返回体里的 Token 痕迹抹掉 */
function redact(text, token) {
  if (typeof text !== 'string') return text;
  let out = text;
  if (token) out = out.split(token).join(REDACTED);
  // 兜底：任何 Bearer 串都不出现在输出里
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`);
}

function classifyStatus(status, bodyText) {
  if (status === 401 || status === 403) {
    return new McpError('MCP Token 无效、已过期或未提供', {
      kind: 'auth',
      status,
      hint: '请在 https://open.mcd.cn/mcp 重新申请或复制 Token，再更新环境变量 MCD_MCP_TOKEN。',
    });
  }
  if (status === 429) {
    return new McpError('触发官方限流（600 请求/分钟）', {
      kind: 'rate_limit',
      status,
      hint: '稍后重试，或调大 --min-interval-ms；不要循环重试。',
    });
  }
  if (status === 404) {
    return new McpError('MCP 会话不存在或已过期', {
      kind: 'session',
      status,
      hint: '客户端会自动重新握手一次；若持续出现请检查服务端地址。',
    });
  }
  return new McpError(`MCP 服务返回 HTTP ${status}`, {
    kind: 'http',
    status,
    hint: bodyText ? `响应片段：${bodyText.slice(0, 200)}` : '',
  });
}

export class McpClient {
  #token;
  #endpoint;
  #sessionId = null;
  #nextId = 1;
  #lastRequestAt = 0;
  #minIntervalMs;
  #timeoutMs;
  #fetchImpl;
  #requestCount = 0;

  constructor({
    endpoint = DEFAULT_ENDPOINT,
    token,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!token) {
      throw new McpError('缺少 MCP Token', {
        kind: 'config',
        hint: '设置环境变量 MCD_MCP_TOKEN，或先用 --demo 体验离线演示模式。',
      });
    }
    this.#token = token;
    this.#endpoint = endpoint;
    this.#minIntervalMs = minIntervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetchImpl = fetchImpl;
  }

  /** 安全描述信息，可放心打印/写日志：不含 Token 本身 */
  describe() {
    return {
      endpoint: this.#endpoint,
      hasToken: Boolean(this.#token),
      tokenPreview: this.#token ? `${this.#token.slice(0, 3)}…${this.#token.slice(-2)}` : null,
      sessionBound: Boolean(this.#sessionId),
      requestCount: this.#requestCount,
    };
  }

  get requestCount() {
    return this.#requestCount;
  }

  /** 保证 JSON.stringify(client) 不会泄露 Token */
  toJSON() {
    return this.describe();
  }

  async #throttle() {
    const elapsed = Date.now() - this.#lastRequestAt;
    if (elapsed < this.#minIntervalMs) await delay(this.#minIntervalMs - elapsed);
    this.#lastRequestAt = Date.now();
  }

  async #post(body) {
    await this.#throttle();
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.#token}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    this.#requestCount += 1;
    try {
      return await this.#fetchImpl(this.#endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new McpError(`请求超时（${this.#timeoutMs}ms）`, {
          kind: 'timeout',
          hint: '网络或服务端较慢，可调大 --timeout-ms 后重试。',
        });
      }
      throw new McpError(`无法连接 MCP 服务：${redact(String(err?.message ?? err), this.#token)}`, {
        kind: 'network',
        hint: '检查网络、代理设置与端点地址。',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读取 SSE 流直到拿到指定 id 的 JSON-RPC 响应 */
  async #readSseForId(res, id) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const payload = event
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!payload) continue;
          let message;
          try {
            message = JSON.parse(payload);
          } catch {
            continue;
          }
          if (message.id === id) {
            await reader.cancel().catch(() => {});
            return message;
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return null;
  }

  async #request(method, params, { notification = false, retryOnSessionLoss = true } = {}) {
    const id = notification ? undefined : this.#nextId++;
    const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };

    const res = await this.#post(body);

    // 服务端可能在 initialize 响应里下发会话 id
    const sessionHeader = res.headers.get('mcp-session-id');
    if (sessionHeader) this.#sessionId = sessionHeader;

    if (res.status === 404 && retryOnSessionLoss && !notification) {
      this.#sessionId = null;
      await this.connect();
      return this.#request(method, params, { notification, retryOnSessionLoss: false });
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const text = await res.text().catch(() => '');
      throw classifyStatus(res.status, redact(text, this.#token));
    }

    if (notification) {
      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        throw classifyStatus(res.status, redact(text, this.#token));
      }
      return null;
    }

    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw classifyStatus(res.status, redact(text, this.#token));
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let message = null;
    if (contentType.includes('text/event-stream')) {
      message = await this.#readSseForId(res, id);
    } else if (res.status === 202 || res.status === 204) {
      message = null;
    } else {
      const text = await res.text();
      if (text) {
        try {
          message = JSON.parse(text);
        } catch {
          throw new McpError('MCP 服务返回了无法解析的响应', {
            kind: 'protocol',
            hint: `响应片段：${redact(text.slice(0, 200), this.#token)}`,
          });
        }
      }
    }

    if (!message) {
      throw new McpError(`MCP 响应中缺少 id=${id} 的消息`, {
        kind: 'protocol',
        hint: '服务端可能未按 Streamable HTTP 规范返回；请保留原始日志反馈。',
      });
    }
    if (message.error) {
      throw new McpError(redact(message.error.message ?? 'MCP 调用失败', this.#token), {
        kind: 'rpc',
        code: message.error.code ?? null,
        hint: redact(message.error.data ? JSON.stringify(message.error.data).slice(0, 200) : '', this.#token),
      });
    }
    return message.result;
  }

  /** 握手：initialize + initialized 通知 */
  async connect() {
    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO,
    });
    await this.#request('notifications/initialized', {}, { notification: true });
    return {
      protocolVersion: result?.protocolVersion ?? null,
      serverInfo: result?.serverInfo ?? null,
      capabilities: result?.capabilities ?? null,
    };
  }

  /** 枚举全部工具（自动翻页），返回原始 schema，供 CLI 做能力自检 */
  async listTools() {
    const tools = [];
    let cursor;
    do {
      const params = cursor ? { cursor } : {};
      const result = await this.#request('tools/list', params);
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      cursor = result?.nextCursor ?? undefined;
    } while (cursor);
    return tools;
  }

  /**
   * 调用工具并归一化返回：
   *  - data: 尽量解析出的结构化对象（JSON 文本或 structuredContent）
   *  - raw : 原始文本，解析失败时也不会丢信息
   *  - isError: 服务端标记的工具级错误
   */
  async callTool(name, args = {}) {
    const result = await this.#request('tools/call', { name, arguments: args });
    const content = Array.isArray(result?.content) ? result.content : [];
    const raw = content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');

    let data = null;
    if (result?.structuredContent && typeof result.structuredContent === 'object') {
      data = result.structuredContent;
    } else if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }

    return {
      data,
      raw: redact(raw, this.#token),
      isError: Boolean(result?.isError),
      tool: name,
    };
  }
}
