// LLM access. All calls go through Bifrost (so provider keys, fallbacks, budgets and logs
// stay in the gateway) with the engine's virtual key and the internal token, which the
// Halflife plugin recognises and skips (loop prevention, AD-08).

export type LLMUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
export type JSONRequest = {
  name: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
};
export type JSONResult = { data: unknown; usage: LLMUsage; model: string; ms: number };

export interface LLM {
  readonly model: string;
  readonly kind: "bifrost" | "test";
  json(req: JSONRequest, signal?: AbortSignal): Promise<JSONResult>;
}

export class LLMError extends Error {
  kind: "timeout" | "http" | "parse" | "budget" | "network" | "config";
  status: number;
  retryAfterMs?: number;
  constructor(kind: LLMError["kind"], message: string, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

type Format = "json_schema" | "json_object" | "none";

export type BifrostLLMOptions = {
  bifrostUrl: string;
  model: string;
  virtualKey: string;
  internalToken: string;
  fallbacks?: string[];
  /** Provider-specific request fields merged into the body (e.g. DeepSeek's `thinking`). Bifrost
   *  forwards unknown body fields to the provider as extra params. */
  extraBody?: Record<string, unknown>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export class BifrostLLM implements LLM {
  readonly model: string;
  readonly kind = "bifrost" as const;
  private opts: BifrostLLMOptions;
  private format: Format = "json_schema";
  private fetchImpl: typeof fetch;

  constructor(opts: BifrostLLMOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async json(req: JSONRequest, signal?: AbortSignal): Promise<JSONResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.once(req, signal);
      } catch (e) {
        lastErr = e;
        if (!(e instanceof LLMError)) throw e;
        if (e.kind === "http" && e.status === 400 && this.format !== "none" && FORMAT_ERROR.test(e.message)) {
          // Provider rejected structured output: step down and retry immediately. Other 400s
          // (context length, a bad parameter) must not permanently degrade the format.
          this.format = this.format === "json_schema" ? "json_object" : "none";
          continue;
        }
        const retryable = e.kind === "timeout" || e.kind === "network" || (e.kind === "http" && (e.status >= 500 || e.status === 429)) || e.kind === "parse";
        if (!retryable || attempt >= 1 || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, e.retryAfterMs ?? 600));
      }
    }
    throw lastErr;
  }

  private async once(req: JSONRequest, signal?: AbortSignal): Promise<JSONResult> {
    const body: Record<string, unknown> = {
      ...this.opts.extraBody,
      model: this.opts.model,
      temperature: 0,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (this.format === "json_schema") {
      body.response_format = { type: "json_schema", json_schema: { name: req.name, strict: true, schema: req.schema } };
    } else if (this.format === "json_object") {
      body.response_format = { type: "json_object" };
    }
    if (this.opts.fallbacks?.length) body.fallbacks = this.opts.fallbacks;
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.bifrostUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bf-vk": this.opts.virtualKey,
          "x-halflife-internal": this.opts.internalToken,
        },
        body: JSON.stringify(body),
        signal: sig,
      });
    } catch (e) {
      if (timeout.aborted) throw new LLMError("timeout", `LLM call exceeded ${this.opts.timeoutMs} ms`);
      if (signal?.aborted) throw new LLMError("timeout", "LLM call cancelled (job budget)");
      throw new LLMError("network", `LLM call failed: ${(e as Error).message}`);
    }
    const text = await res.text();
    // 402 is either the Bifrost VK budget or the provider's own balance (DeepSeek: "Insufficient
    // Balance"). Both are spend limits and are never retried; the upstream message says which.
    if (res.status === 402) throw new LLMError("budget", `LLM spend limit (HTTP 402): ${errorMessage(text) || "budget exhausted"}`, 402);
    if (!res.ok) {
      const err = new LLMError("http", `LLM HTTP ${res.status}: ${errorMessage(text)}`, res.status);
      if (res.status === 429) err.retryAfterMs = retryAfterMs(res.headers.get("retry-after"));
      throw err;
    }
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LLMError("parse", "LLM response was not JSON");
    }
    const content = payload?.choices?.[0]?.message?.content;
    const str = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? "").join("") : "";
    const data = parseJSONLoose(str);
    // DeepSeek's JSON mode can return blank content with finish_reason "stop": a parse error,
    // retried once.
    if (data === undefined) throw new LLMError("parse", str.trim() ? "model did not return valid JSON" : "model returned empty content");
    return { data, usage: payload?.usage ?? {}, model: payload?.model ?? this.opts.model, ms: Math.round(performance.now() - t0) };
  }
}

const FORMAT_ERROR = /response_format|json|schema/i;

/** Retry-After (seconds or an HTTP date), clamped to 0.5–5 s so one retry can't eat a job budget. */
function retryAfterMs(h: string | null): number {
  if (!h) return 1000;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Math.min(5000, Math.max(500, Number.isFinite(ms) ? ms : 1000));
}

function errorMessage(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    return typeof m === "string" ? m.slice(0, 300) : body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

/** Parse JSON from model output, tolerating code fences and surrounding prose. */
export function parseJSONLoose(s: string): unknown {
  if (!s) return undefined;
  const t = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
