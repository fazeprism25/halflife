// TEST DOUBLES ONLY. Never imported by engine/src. Every value these produce is a scripted
// test fixture, not a real model output or a real search result (AD-13).

import type { JSONRequest, JSONResult, LLM } from "../src/llm.ts";
import type { ExtractResponse, Search, SearchParams, SearchResponse } from "../src/tavily.ts";
import { loadConfig, type Config } from "../src/config.ts";

export class FakeLLM implements LLM {
  readonly model = "test/fake-llm";
  readonly kind = "test" as const;
  calls: JSONRequest[] = [];
  handlers: Record<string, (req: JSONRequest, n: number) => unknown>;
  constructor(handlers: Record<string, (req: JSONRequest, n: number) => unknown>) {
    this.handlers = handlers;
  }
  async json(req: JSONRequest): Promise<JSONResult> {
    this.calls.push(req);
    const h = this.handlers[req.name];
    if (!h) throw new Error(`FakeLLM: no handler for ${req.name}`);
    const n = this.calls.filter((c) => c.name === req.name).length;
    const data = h(req, n);
    if (data instanceof Error) throw data;
    return { data, usage: { total_tokens: 100 }, model: this.model, ms: 1 };
  }
}

export class FakeSearch implements Search {
  readonly kind = "test" as const;
  searches: SearchParams[] = [];
  extracts: string[][] = [];
  results: (p: SearchParams) => SearchResponse["results"] | Error;
  extractResults: (urls: string[]) => ExtractResponse["results"];
  constructor(results: FakeSearch["results"], extractResults: FakeSearch["extractResults"] = () => []) {
    this.results = results;
    this.extractResults = extractResults;
  }
  async search(p: SearchParams): Promise<SearchResponse> {
    this.searches.push(p);
    const r = this.results(p);
    if (r instanceof Error) throw r;
    return { results: r, credits: 1, ms: 1 };
  }
  async extract(urls: string[]): Promise<ExtractResponse> {
    this.extracts.push(urls);
    return { results: this.extractResults(urls), failed: [], credits: 1, ms: 1 };
  }
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    engineVK: "sk-bf-engine-test",
    internalToken: "internal-test",
    ingestToken: "ingest-test",
    relayToken: "relay-test",
    llmModel: "test/fake-llm",
    tavilyEnabled: true,
    ...over,
  };
}

export const NOW = Date.UTC(2026, 10, 2, 12, 0, 0); // 2026-11-02T12:00Z, fixed for determinism
