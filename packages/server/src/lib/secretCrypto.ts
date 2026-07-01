import crypto from "node:crypto";

/**
 * Encryption-at-rest for secrets persisted in the `settings` table (LDAP bind
 * password, GitHub token, webhook/Slack signing secrets, LLM/embedding provider API
 * keys). Opt-in via SPECREG_SECRET_KEY: the key must come from outside the database
 * so a stolen/leaked SQLite file alone does not also hand over the decryption key.
 *
 * Values are self-describing (`enc:v1:<base64>` prefix) so plaintext rows written
 * before SPECREG_SECRET_KEY was configured keep working, and encryption can be
 * turned on for a deployment without a forced migration step.
 */

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
// Fixed application-level salt: SPECREG_SECRET_KEY is the actual secret input: this
// salt only domain-separates the derived key from other uses of the same passphrase.
const KEY_DERIVATION_SALT = "specregistry-secret-key-v1";

let cachedKey: { source: string; key: Buffer } | undefined;

function masterKey(): Buffer | undefined {
  const source = process.env.SPECREG_SECRET_KEY;
  if (!source) return undefined;
  if (cachedKey?.source === source) return cachedKey.key;
  const key = crypto.scryptSync(source, KEY_DERIVATION_SALT, 32);
  cachedKey = { source, key };
  return key;
}

export function encryptionConfigured(): boolean {
  return Boolean(process.env.SPECREG_SECRET_KEY);
}

/** Encrypts a non-empty secret when SPECREG_SECRET_KEY is set; otherwise returns it unchanged. */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  const key = masterKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypts a value produced by encryptSecret. Values without the marker are
 * returned unchanged (plaintext rows saved before encryption was configured).
 * Throws if a value is encrypted but SPECREG_SECRET_KEY is missing or wrong,
 * rather than silently returning ciphertext as if it were a usable secret.
 */
export function decryptSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  const key = masterKey();
  if (!key) {
    throw new Error(
      "A stored secret is encrypted but SPECREG_SECRET_KEY is not set. Set the same " +
        "SPECREG_SECRET_KEY used to encrypt it, or re-save the value after clearing it."
    );
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
