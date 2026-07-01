import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, encryptionConfigured } from "../src/lib/secretCrypto.js";

afterEach(() => {
  delete process.env.SPECREG_SECRET_KEY;
});

describe("secretCrypto", () => {
  it("passes values through unchanged when SPECREG_SECRET_KEY is not set", () => {
    expect(encryptionConfigured()).toBe(false);
    expect(encryptSecret("hello")).toBe("hello");
    expect(decryptSecret("hello")).toBe("hello");
  });

  it("round-trips a secret once SPECREG_SECRET_KEY is set", () => {
    process.env.SPECREG_SECRET_KEY = "unit-test-key";
    expect(encryptionConfigured()).toBe(true);
    const encrypted = encryptSecret("super-secret-value");
    expect(encrypted).not.toBe("super-secret-value");
    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("super-secret-value");
  });

  it("never encrypts an empty string, so 'not set' stays distinguishable from 'set to empty'", () => {
    process.env.SPECREG_SECRET_KEY = "unit-test-key";
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
  });

  it("passes through legacy plaintext values that predate SPECREG_SECRET_KEY being configured", () => {
    process.env.SPECREG_SECRET_KEY = "unit-test-key";
    expect(decryptSecret("a-plaintext-value-saved-before-encryption-was-enabled")).toBe(
      "a-plaintext-value-saved-before-encryption-was-enabled"
    );
  });

  it("refuses to silently return ciphertext when the key is missing at decrypt time", () => {
    process.env.SPECREG_SECRET_KEY = "unit-test-key";
    const encrypted = encryptSecret("super-secret-value");
    delete process.env.SPECREG_SECRET_KEY;
    expect(() => decryptSecret(encrypted)).toThrow(/SPECREG_SECRET_KEY/);
  });

  it("fails decryption with the wrong key rather than returning garbage", () => {
    process.env.SPECREG_SECRET_KEY = "key-one";
    const encrypted = encryptSecret("super-secret-value");
    process.env.SPECREG_SECRET_KEY = "key-two";
    expect(() => decryptSecret(encrypted)).toThrow();
  });
});
