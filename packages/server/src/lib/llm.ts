import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db.js";
import { HttpError } from "../helpers.js";

export type LlmProvider = "anthropic" | "openai" | "gemini" | "openai_compatible";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  base_url: string;
  api_key: string;
  max_tokens: number;
}

export interface PublicLlmConfig extends Omit<LlmConfig, "api_key"> {
  has_api_key: boolean;
}

export type LlmTier = "cheap" | "standard" | "frontier";
export type LlmTaskRoute =
  | "classification"
  | "summarization"
  | "spec_generation"
  | "task_planning"
  | "ticket_generation"
  | "audit"
  | "draft_fix"
  | "efficacy"
  | "maintenance"
  | "test";

export interface PublicLlmTierConfig extends PublicLlmConfig {
  tier: LlmTier;
  label: string;
  description: string;
}

export interface LlmTieringConfig {
  tiers: Record<LlmTier, PublicLlmTierConfig>;
  routes: Record<LlmTaskRoute, LlmTier>;
}

const KEYS = {
  provider: "llm.provider",
  model: "llm.model",
  base_url: "llm.base_url",
  api_key: "llm.api_key",
  max_tokens: "llm.max_tokens",
};

export const LLM_TIERS: Array<{ tier: LlmTier; label: string; description: string }> = [
  { tier: "cheap", label: "Cheap / local", description: "Fast, low-cost models for classification, summarization, and planning." },
  { tier: "standard", label: "Standard", description: "Default balanced model for general automation." },
  { tier: "frontier", label: "Frontier", description: "Highest-quality model for final audits, generation, and draft fixes." },
];

export const DEFAULT_LLM_ROUTES: Record<LlmTaskRoute, LlmTier> = {
  classification: "cheap",
  summarization: "cheap",
  task_planning: "cheap",
  ticket_generation: "standard",
  maintenance: "standard",
  spec_generation: "frontier",
  audit: "frontier",
  draft_fix: "frontier",
  efficacy: "frontier",
  test: "standard",
};

export const LLM_TIER_VALUES: LlmTier[] = ["cheap", "standard", "frontier"];
export const LLM_ROUTE_VALUES: LlmTaskRoute[] = Object.keys(DEFAULT_LLM_ROUTES) as LlmTaskRoute[];

const GEMINI_MODEL_FALLBACKS = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite-preview-12-2025",
  "gemini-3-pro-preview",
  "gemini-3-pro-image-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

function uniqueModels(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const group of groups) {
    for (const model of group) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      models.push(model);
    }
  }
  return models;
}

function openAiCompatibleBase(config: Pick<LlmConfig, "provider" | "base_url">): string {
  const raw =
    config.provider === "openai"
      ? config.base_url || "https://api.openai.com/v1"
      : config.base_url;
  const trimmed = raw.replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/v1";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Fall through and use the literal value; the fetch error will be explicit.
  }
  return trimmed;
}

function textFromOpenAiChoice(body: unknown): string {
  const choices = (body as { choices?: unknown[] })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0] as {
    text?: unknown;
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
  };
  const content = first.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
          if (typeof record.content === "string") return record.content;
        }
        return "";
      })
      .join("")
      .trim();
    if (text) return text;
  }
  if (typeof first.text === "string" && first.text.trim()) return first.text.trim();
  return "";
}

function noTextDetail(body: unknown): string {
  const choice = (body as { choices?: Array<Record<string, unknown>> })?.choices?.[0];
  const finish = typeof choice?.finish_reason === "string" ? ` finish_reason=${choice.finish_reason};` : "";
  const keys = choice ? ` choice_keys=${Object.keys(choice).join(",")};` : "";
  return `LLM returned no text.${finish}${keys} Verify the selected model is a chat/completions model and that the base URL points at the OpenAI-compatible /v1 API.`;
}

function settingMap(db: Db): Map<string, string> {
  return new Map(
    (db.prepare("SELECT key, value FROM settings WHERE key LIKE 'llm.%'").all() as Array<{ key: string; value: string }>).map(
      (row) => [row.key, row.value]
    )
  );
}

function envProvider(): LlmProvider {
  if (process.env.LLM_PROVIDER === "openai") return "openai";
  if (process.env.LLM_PROVIDER === "gemini") return "gemini";
  if (process.env.LLM_PROVIDER === "openai_compatible") return "openai_compatible";
  if (process.env.LLM_BASE_URL) return "openai_compatible";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  return "anthropic";
}

export function getLlmConfig(db: Db): LlmConfig {
  const settings = settingMap(db);
  const provider = (settings.get(KEYS.provider) || process.env.LLM_PROVIDER || envProvider()) as LlmProvider;
  const normalizedProvider: LlmProvider =
    provider === "openai" || provider === "gemini" || provider === "openai_compatible" ? provider : "anthropic";
  return {
    provider: normalizedProvider,
    model:
      settings.get(KEYS.model) ||
      process.env.LLM_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.GEMINI_MODEL ||
      (normalizedProvider === "anthropic"
        ? "claude-opus-4-8"
        : normalizedProvider === "openai"
          ? "gpt-4.1"
          : normalizedProvider === "gemini"
            ? "gemini-3.5-flash"
            : "llama3.1"),
    base_url: settings.get(KEYS.base_url) || process.env.LLM_BASE_URL || "",
    api_key:
      settings.get(KEYS.api_key) ||
      process.env.LLM_API_KEY ||
      (normalizedProvider === "anthropic"
        ? process.env.ANTHROPIC_API_KEY ?? ""
        : normalizedProvider === "openai"
          ? process.env.OPENAI_API_KEY ?? ""
          : normalizedProvider === "gemini"
            ? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? ""
            : ""),
    max_tokens: Math.max(1, Number(settings.get(KEYS.max_tokens) || process.env.LLM_MAX_TOKENS || 16000)),
  };
}

function tierKey(tier: LlmTier, field: keyof typeof KEYS): string {
  return `llm.tier.${tier}.${KEYS[field].replace("llm.", "")}`;
}

function routeKey(route: LlmTaskRoute): string {
  return `llm.route.${route}`;
}

function defaultConfigForTier(db: Db, tier: LlmTier): LlmConfig {
  const base = getLlmConfig(db);
  if (tier === "cheap" && (process.env.LLM_LOCAL_BASE_URL || process.env.LLM_CHEAP_BASE_URL)) {
    return {
      provider: "openai_compatible",
      model: process.env.LLM_CHEAP_MODEL || process.env.LLM_LOCAL_MODEL || "local-model",
      base_url: process.env.LLM_CHEAP_BASE_URL || process.env.LLM_LOCAL_BASE_URL || "",
      api_key: process.env.LLM_CHEAP_API_KEY || process.env.LLM_LOCAL_API_KEY || "",
      max_tokens: Math.max(1, Number(process.env.LLM_CHEAP_MAX_TOKENS || 4000)),
    };
  }
  if (tier === "frontier") {
    return {
      ...base,
      model:
        process.env.LLM_FRONTIER_MODEL ||
        process.env.ANTHROPIC_MODEL ||
        process.env.OPENAI_MODEL ||
        process.env.GEMINI_MODEL ||
        base.model,
      max_tokens: Math.max(1, Number(process.env.LLM_FRONTIER_MAX_TOKENS || base.max_tokens)),
    };
  }
  return base;
}

export function getLlmTierConfig(db: Db, tier: LlmTier): LlmConfig {
  const map = settingMap(db);
  const fallback = defaultConfigForTier(db, tier);
  const provider = (map.get(tierKey(tier, "provider")) || fallback.provider) as LlmProvider;
  const normalizedProvider: LlmProvider =
    provider === "openai" || provider === "gemini" || provider === "openai_compatible" || provider === "anthropic"
      ? provider
      : fallback.provider;
  return {
    provider: normalizedProvider,
    model: map.get(tierKey(tier, "model")) || fallback.model,
    base_url: map.get(tierKey(tier, "base_url")) || fallback.base_url,
    api_key: map.get(tierKey(tier, "api_key")) || fallback.api_key,
    max_tokens: Math.max(1, Number(map.get(tierKey(tier, "max_tokens")) || fallback.max_tokens)),
  };
}

export function publicLlmTierConfig(db: Db, tier: LlmTier, config = getLlmTierConfig(db, tier)): PublicLlmTierConfig {
  const meta = LLM_TIERS.find((item) => item.tier === tier)!;
  return { ...publicLlmConfig(db, config), tier, label: meta.label, description: meta.description };
}

export function getLlmRouteTier(db: Db, route: LlmTaskRoute): LlmTier {
  const map = settingMap(db);
  const value = map.get(routeKey(route));
  return value === "cheap" || value === "standard" || value === "frontier" ? value : DEFAULT_LLM_ROUTES[route] ?? "standard";
}

export function getLlmConfigForRoute(db: Db, route: LlmTaskRoute): LlmConfig {
  return getLlmTierConfig(db, getLlmRouteTier(db, route));
}

export function publicLlmTieringConfig(db: Db): LlmTieringConfig {
  return {
    tiers: {
      cheap: publicLlmTierConfig(db, "cheap"),
      standard: publicLlmTierConfig(db, "standard"),
      frontier: publicLlmTierConfig(db, "frontier"),
    },
    routes: Object.fromEntries(
      (Object.keys(DEFAULT_LLM_ROUTES) as LlmTaskRoute[]).map((route) => [route, getLlmRouteTier(db, route)])
    ) as Record<LlmTaskRoute, LlmTier>,
  };
}

export function publicLlmConfig(db: Db, config = getLlmConfig(db)): PublicLlmConfig {
  const { api_key: _secret, ...rest } = config;
  return { ...rest, has_api_key: Boolean(config.api_key) };
}

export function saveLlmConfig(
  db: Db,
  input: Partial<LlmConfig> & { clear_api_key?: boolean }
): LlmConfig {
  const current = getLlmConfig(db);
  const provider =
    input.provider === "openai" ||
    input.provider === "gemini" ||
    input.provider === "openai_compatible" ||
    input.provider === "anthropic"
      ? input.provider
      : current.provider;
  const next: LlmConfig = {
    provider,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : current.model,
    base_url: typeof input.base_url === "string" ? input.base_url.trim() : current.base_url,
    api_key: typeof input.api_key === "string" && input.api_key ? input.api_key : current.api_key,
    max_tokens: Math.max(1, Number(input.max_tokens ?? current.max_tokens)),
  };
  if (input.clear_api_key) next.api_key = "";

  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  upsert.run(KEYS.provider, next.provider);
  upsert.run(KEYS.model, next.model);
  upsert.run(KEYS.base_url, next.base_url);
  upsert.run(KEYS.api_key, next.api_key);
  upsert.run(KEYS.max_tokens, String(next.max_tokens));
  return next;
}

export function saveLlmTierConfig(
  db: Db,
  tier: LlmTier,
  input: Partial<LlmConfig> & { clear_api_key?: boolean }
): LlmConfig {
  const current = getLlmTierConfig(db, tier);
  const provider =
    input.provider === "openai" ||
    input.provider === "gemini" ||
    input.provider === "openai_compatible" ||
    input.provider === "anthropic"
      ? input.provider
      : current.provider;
  const next: LlmConfig = {
    provider,
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : current.model,
    base_url: typeof input.base_url === "string" ? input.base_url.trim() : current.base_url,
    api_key: typeof input.api_key === "string" && input.api_key ? input.api_key : current.api_key,
    max_tokens: Math.max(1, Number(input.max_tokens ?? current.max_tokens)),
  };
  if (input.clear_api_key) next.api_key = "";
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  upsert.run(tierKey(tier, "provider"), next.provider);
  upsert.run(tierKey(tier, "model"), next.model);
  upsert.run(tierKey(tier, "base_url"), next.base_url);
  upsert.run(tierKey(tier, "api_key"), next.api_key);
  upsert.run(tierKey(tier, "max_tokens"), String(next.max_tokens));
  if (tier === "standard") saveLlmConfig(db, { ...next, clear_api_key: input.clear_api_key });
  return next;
}

export function saveLlmRoutes(db: Db, routes: Partial<Record<LlmTaskRoute, LlmTier>>): Record<LlmTaskRoute, LlmTier> {
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const route of LLM_ROUTE_VALUES) {
    const tier = routes[route];
    if (tier === "cheap" || tier === "standard" || tier === "frontier") upsert.run(routeKey(route), tier);
  }
  return publicLlmTieringConfig(db).routes;
}

export interface LlmTextInput {
  system: string;
  user: string;
  maxTokens?: number;
  route?: LlmTaskRoute;
  tier?: LlmTier;
}

export async function runLlmText(
  db: Db,
  input: LlmTextInput
): Promise<{ text: string; model: string; provider: LlmProvider; tier: LlmTier; route: LlmTaskRoute }> {
  const route = input.route ?? "test";
  const tier = input.tier ?? getLlmRouteTier(db, route);
  const config = getLlmTierConfig(db, tier);
  const maxTokens = input.maxTokens ?? config.max_tokens;
  if (config.provider === "anthropic") {
    if (!config.api_key) throw new HttpError(503, "LLM provider anthropic requires ANTHROPIC_API_KEY, LLM_API_KEY, or a saved API key");
    const client = new Anthropic({
      apiKey: config.api_key,
      ...(config.base_url ? { baseURL: config.base_url } : {}),
    });
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    });
    const message = await stream.finalMessage();
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, `LLM returned no text (stop_reason: ${message.stop_reason})`);
    return { text, model: config.model, provider: config.provider, tier, route };
  }

  if (config.provider === "gemini") {
    if (!config.api_key) throw new HttpError(503, "LLM provider gemini requires GEMINI_API_KEY, GOOGLE_API_KEY, LLM_API_KEY, or a saved API key");
    const base = (config.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const modelPath = config.model.startsWith("models/") ? config.model : `models/${config.model}`;
    const res = await fetch(`${base}/${modelPath}:generateContent?key=${encodeURIComponent(config.api_key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generationConfig: { maxOutputTokens: maxTokens },
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
      }),
    });
    if (!res.ok) throw new HttpError(502, `LLM provider error ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
    if (!text) throw new HttpError(502, "LLM returned no text");
    return { text, model: config.model, provider: config.provider, tier, route };
  }

  const openAiBase = openAiCompatibleBase(config);
  if (!openAiBase) {
    throw new HttpError(503, "LLM provider openai_compatible requires LLM_BASE_URL or a saved base URL");
  }
  if (config.provider === "openai" && !config.api_key) {
    throw new HttpError(503, "LLM provider openai requires OPENAI_API_KEY, LLM_API_KEY, or a saved API key");
  }
  const res = await fetch(`${openAiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.api_key ? { authorization: `Bearer ${config.api_key}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new HttpError(502, `LLM provider error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const text = textFromOpenAiChoice(body);
  if (!text) throw new HttpError(502, noTextDetail(body));
  return { text, model: config.model, provider: config.provider, tier, route };
}

export async function listLlmModels(db: Db, tier?: LlmTier): Promise<{ provider: LlmProvider; models: string[]; tier?: LlmTier }> {
  const config = tier ? getLlmTierConfig(db, tier) : getLlmConfig(db);
  if (config.provider === "anthropic") {
    if (!config.api_key) {
      return { provider: config.provider, models: ["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"], tier };
    }
    const client = new Anthropic({ apiKey: config.api_key, ...(config.base_url ? { baseURL: config.base_url } : {}) });
    const page = await client.models.list({ limit: 100 });
    return { provider: config.provider, models: page.data.map((model) => model.id), tier };
  }
  if (config.provider === "gemini") {
    if (!config.api_key) {
      return { provider: config.provider, models: GEMINI_MODEL_FALLBACKS, tier };
    }
    const base = (config.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const res = await fetch(`${base}/models?key=${encodeURIComponent(config.api_key)}`);
    if (!res.ok) throw new HttpError(502, `LLM model list error ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const models = (body.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => (model.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return { provider: config.provider, models: uniqueModels(GEMINI_MODEL_FALLBACKS, models), tier };
  }

  const base = openAiCompatibleBase(config);
  if (!base) return { provider: config.provider, models: [], tier };
  const res = await fetch(`${base}/models`, {
    headers: { ...(config.api_key ? { authorization: `Bearer ${config.api_key}` } : {}) },
  });
  if (!res.ok) throw new HttpError(502, `LLM model list error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return { provider: config.provider, models: (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)), tier };
}
