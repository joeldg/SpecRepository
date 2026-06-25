import crypto from "node:crypto";
import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";
import { now } from "../db.js";
import { HttpError } from "../helpers.js";
import { sectionAnchor, splitSections } from "./sections.js";

export type EmbeddingProvider = "local_hash" | "openai" | "gemini" | "openai_compatible";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  base_url: string;
  api_key: string;
  dimensions: number;
}

export interface PublicEmbeddingConfig extends Omit<EmbeddingConfig, "api_key"> {
  has_api_key: boolean;
}

const KEYS = {
  provider: "embedding.provider",
  model: "embedding.model",
  base_url: "embedding.base_url",
  api_key: "embedding.api_key",
  dimensions: "embedding.dimensions",
};

function settings(db: Db): Map<string, string> {
  return new Map(
    (db.prepare("SELECT key, value FROM settings WHERE key LIKE 'embedding.%'").all() as Array<{ key: string; value: string }>).map(
      (row) => [row.key, row.value]
    )
  );
}

function envProvider(): EmbeddingProvider {
  if (process.env.EMBEDDING_PROVIDER === "openai") return "openai";
  if (process.env.EMBEDDING_PROVIDER === "gemini") return "gemini";
  if (process.env.EMBEDDING_PROVIDER === "openai_compatible") return "openai_compatible";
  if (process.env.EMBEDDING_BASE_URL) return "openai_compatible";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  return "local_hash";
}

function normalizeProvider(value: string | undefined): EmbeddingProvider {
  return value === "openai" || value === "gemini" || value === "openai_compatible" || value === "local_hash"
    ? value
    : "local_hash";
}

export function getEmbeddingConfig(db: Db): EmbeddingConfig {
  const map = settings(db);
  const provider = normalizeProvider(map.get(KEYS.provider) || process.env.EMBEDDING_PROVIDER || envProvider());
  return {
    provider,
    model:
      map.get(KEYS.model) ||
      process.env.EMBEDDING_MODEL ||
      (provider === "openai"
        ? "text-embedding-3-small"
        : provider === "gemini"
          ? "gemini-embedding-001"
          : provider === "openai_compatible"
            ? "nomic-embed-text"
            : "local-hash-v1"),
    base_url: map.get(KEYS.base_url) || process.env.EMBEDDING_BASE_URL || "",
    api_key:
      map.get(KEYS.api_key) ||
      process.env.EMBEDDING_API_KEY ||
      (provider === "openai"
        ? process.env.OPENAI_API_KEY ?? ""
        : provider === "gemini"
          ? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? ""
          : ""),
    dimensions: Math.max(16, Number(map.get(KEYS.dimensions) || process.env.EMBEDDING_DIMENSIONS || 128)),
  };
}

export function publicEmbeddingConfig(db: Db, config = getEmbeddingConfig(db)): PublicEmbeddingConfig {
  const { api_key: _secret, ...rest } = config;
  return { ...rest, has_api_key: Boolean(config.api_key) };
}

export function saveEmbeddingConfig(db: Db, input: Partial<EmbeddingConfig> & { clear_api_key?: boolean }): EmbeddingConfig {
  const current = getEmbeddingConfig(db);
  const next: EmbeddingConfig = {
    provider: normalizeProvider(input.provider ?? current.provider),
    model: typeof input.model === "string" && input.model.trim() ? input.model.trim() : current.model,
    base_url: typeof input.base_url === "string" ? input.base_url.trim() : current.base_url,
    api_key: typeof input.api_key === "string" && input.api_key ? input.api_key : current.api_key,
    dimensions: Math.max(16, Number(input.dimensions ?? current.dimensions)),
  };
  if (input.clear_api_key) next.api_key = "";
  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  upsert.run(KEYS.provider, next.provider);
  upsert.run(KEYS.model, next.model);
  upsert.run(KEYS.base_url, next.base_url);
  upsert.run(KEYS.api_key, next.api_key);
  upsert.run(KEYS.dimensions, String(next.dimensions));
  return next;
}

export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalize(vector: number[]): number[] {
  const mag = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / mag);
}

function localHashEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1);
  for (const term of terms) {
    const digest = crypto.createHash("sha256").update(term).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.log(term.length));
  }
  return normalize(vector);
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(ma) || 1) * (Math.sqrt(mb) || 1));
}

async function embedOpenAiCompatible(config: EmbeddingConfig, text: string): Promise<number[]> {
  const base =
    config.provider === "openai"
      ? (config.base_url || "https://api.openai.com/v1").replace(/\/+$/, "")
      : config.base_url.replace(/\/+$/, "");
  if (!base) throw new HttpError(503, "Embedding provider openai_compatible requires EMBEDDING_BASE_URL or a saved base URL");
  if (config.provider === "openai" && !config.api_key) {
    throw new HttpError(503, "Embedding provider openai requires OPENAI_API_KEY, EMBEDDING_API_KEY, or a saved API key");
  }
  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.api_key ? { authorization: `Bearer ${config.api_key}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input: text }),
  });
  if (!res.ok) throw new HttpError(502, `Embedding provider error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new HttpError(502, "Embedding provider returned no vector");
  return normalize(vector);
}

async function embedGemini(config: EmbeddingConfig, text: string): Promise<number[]> {
  if (!config.api_key) throw new HttpError(503, "Embedding provider gemini requires GEMINI_API_KEY, GOOGLE_API_KEY, EMBEDDING_API_KEY, or a saved API key");
  const base = (config.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const modelPath = config.model.startsWith("models/") ? config.model : `models/${config.model}`;
  const res = await fetch(`${base}/${modelPath}:embedContent?key=${encodeURIComponent(config.api_key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: { parts: [{ text }] } }),
  });
  if (!res.ok) throw new HttpError(502, `Embedding provider error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { embedding?: { values?: number[] } };
  const vector = body.embedding?.values;
  if (!Array.isArray(vector)) throw new HttpError(502, "Embedding provider returned no vector");
  return normalize(vector);
}

export async function embedText(db: Db, text: string, config = getEmbeddingConfig(db)): Promise<number[]> {
  if (config.provider === "local_hash") return localHashEmbedding(text, config.dimensions);
  if (config.provider === "gemini") return embedGemini(config, text);
  return embedOpenAiCompatible(config, text);
}

export async function reindexSemanticSpec(db: Db, spec: Pick<Spec, "id" | "content">, config = getEmbeddingConfig(db)): Promise<number> {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO spec_embeddings
       (spec_id, section, section_anchor, content_hash, provider, model, dimensions, vector, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let count = 0;
  for (const chunk of splitSections(spec.content)) {
    const anchor = sectionAnchor(chunk.section);
    const hash = contentHash(chunk.text);
    const existing = db
      .prepare(
        `SELECT content_hash FROM spec_embeddings
         WHERE spec_id = ? AND section_anchor = ? AND provider = ? AND model = ?`
      )
      .get(spec.id, anchor, config.provider, config.model) as { content_hash: string } | undefined;
    if (existing?.content_hash === hash) continue;
    const vector = await embedText(db, chunk.text, config);
    insert.run(spec.id, chunk.section, anchor, hash, config.provider, config.model, vector.length, JSON.stringify(vector), now());
    count++;
  }
  return count;
}

export async function reindexSemanticAll(db: Db, config = getEmbeddingConfig(db)): Promise<{ indexed_sections: number; provider: string; model: string }> {
  const specs = db.prepare("SELECT id, content FROM specs WHERE status != 'draft' AND deleted_at IS NULL").all() as Array<Pick<Spec, "id" | "content">>;
  let indexed = 0;
  for (const spec of specs) indexed += await reindexSemanticSpec(db, spec, config);
  return { indexed_sections: indexed, provider: config.provider, model: config.model };
}

export function semanticIndexStatus(db: Db) {
  const config = getEmbeddingConfig(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sections, MAX(updated_at) AS last_indexed_at
       FROM spec_embeddings WHERE provider = ? AND model = ?`
    )
    .get(config.provider, config.model) as { sections: number; last_indexed_at: string | null };
  const publishedSections = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM spec_chunks c JOIN specs s ON s.id = c.spec_id
       WHERE s.status != 'draft'`
    )
    .get() as { n: number };
  return {
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    indexed_sections: Number(row.sections ?? 0),
    published_sections: Number(publishedSections.n ?? 0),
    last_indexed_at: row.last_indexed_at,
    ready: Number(row.sections ?? 0) > 0,
  };
}
