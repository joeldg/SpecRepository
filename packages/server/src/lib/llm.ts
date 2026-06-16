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

const KEYS = {
  provider: "llm.provider",
  model: "llm.model",
  base_url: "llm.base_url",
  api_key: "llm.api_key",
  max_tokens: "llm.max_tokens",
};

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
            ? "gemini-2.5-pro"
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

export interface LlmTextInput {
  system: string;
  user: string;
  maxTokens?: number;
}

export async function runLlmText(db: Db, input: LlmTextInput): Promise<{ text: string; model: string; provider: LlmProvider }> {
  const config = getLlmConfig(db);
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
    return { text, model: config.model, provider: config.provider };
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
    return { text, model: config.model, provider: config.provider };
  }

  const openAiBase =
    config.provider === "openai"
      ? (config.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
      : config.base_url.replace(/\/+$/, "");
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
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) throw new HttpError(502, "LLM returned no text");
  return { text, model: config.model, provider: config.provider };
}

export async function listLlmModels(db: Db): Promise<{ provider: LlmProvider; models: string[] }> {
  const config = getLlmConfig(db);
  if (config.provider === "anthropic") {
    if (!config.api_key) {
      return { provider: config.provider, models: ["claude-opus-4-8", "claude-sonnet-4-5", "claude-haiku-4-5"] };
    }
    const client = new Anthropic({ apiKey: config.api_key, ...(config.base_url ? { baseURL: config.base_url } : {}) });
    const page = await client.models.list({ limit: 100 });
    return { provider: config.provider, models: page.data.map((model) => model.id) };
  }
  if (config.provider === "gemini") {
    if (!config.api_key) {
      return { provider: config.provider, models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro"] };
    }
    const base = (config.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    const res = await fetch(`${base}/models?key=${encodeURIComponent(config.api_key)}`);
    if (!res.ok) throw new HttpError(502, `LLM model list error ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const models = (body.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => (model.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    return { provider: config.provider, models };
  }

  const base =
    config.provider === "openai"
      ? (config.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
      : config.base_url.replace(/\/+$/, "");
  if (!base) return { provider: config.provider, models: [] };
  const res = await fetch(`${base}/models`, {
    headers: { ...(config.api_key ? { authorization: `Bearer ${config.api_key}` } : {}) },
  });
  if (!res.ok) throw new HttpError(502, `LLM model list error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return { provider: config.provider, models: (body.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)) };
}
