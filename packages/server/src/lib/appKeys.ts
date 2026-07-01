import type { Db } from "../db.js";
import { decryptSecret, encryptSecret } from "./secretCrypto.js";

export interface AppKeyConfig {
  github_token: string;
  github_webhook_secret: string;
  slack_signing_secret: string;
}

export interface PublicAppKeyConfig {
  has_github_token: boolean;
  has_github_webhook_secret: boolean;
  has_slack_signing_secret: boolean;
}

const KEYS = {
  github_token: "app_keys.github_token",
  github_webhook_secret: "app_keys.github_webhook_secret",
  slack_signing_secret: "app_keys.slack_signing_secret",
};

function readSetting(db: Db, key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function readSecretSetting(db: Db, key: string): string | undefined {
  const value = readSetting(db, key);
  return value ? decryptSecret(value) : value;
}

export function getAppKeyConfig(db: Db): AppKeyConfig {
  return {
    github_token: readSecretSetting(db, KEYS.github_token) || process.env.GITHUB_TOKEN || "",
    github_webhook_secret: readSecretSetting(db, KEYS.github_webhook_secret) || process.env.GITHUB_WEBHOOK_SECRET || "",
    slack_signing_secret: readSecretSetting(db, KEYS.slack_signing_secret) || process.env.SLACK_SIGNING_SECRET || "",
  };
}

export function publicAppKeyConfig(db: Db, config = getAppKeyConfig(db)): PublicAppKeyConfig {
  return {
    has_github_token: Boolean(config.github_token),
    has_github_webhook_secret: Boolean(config.github_webhook_secret),
    has_slack_signing_secret: Boolean(config.slack_signing_secret),
  };
}

export function saveAppKeyConfig(
  db: Db,
  input: Partial<AppKeyConfig> & {
    clear_github_token?: boolean;
    clear_github_webhook_secret?: boolean;
    clear_slack_signing_secret?: boolean;
  }
): AppKeyConfig {
  const current = getAppKeyConfig(db);
  const next: AppKeyConfig = {
    github_token:
      typeof input.github_token === "string" && input.github_token ? input.github_token : current.github_token,
    github_webhook_secret:
      typeof input.github_webhook_secret === "string" && input.github_webhook_secret
        ? input.github_webhook_secret
        : current.github_webhook_secret,
    slack_signing_secret:
      typeof input.slack_signing_secret === "string" && input.slack_signing_secret
        ? input.slack_signing_secret
        : current.slack_signing_secret,
  };

  if (input.clear_github_token) next.github_token = "";
  if (input.clear_github_webhook_secret) next.github_webhook_secret = "";
  if (input.clear_slack_signing_secret) next.slack_signing_secret = "";

  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  upsert.run(KEYS.github_token, encryptSecret(next.github_token));
  upsert.run(KEYS.github_webhook_secret, encryptSecret(next.github_webhook_secret));
  upsert.run(KEYS.slack_signing_secret, encryptSecret(next.slack_signing_secret));
  return next;
}
