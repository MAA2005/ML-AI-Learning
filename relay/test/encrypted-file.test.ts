import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedFileStore } from "../src/secrets/encrypted-file.js";
import { openSecretStore } from "../src/secrets/store.js";

/**
 * Encrypted-file store: real crypto, temp files, no network. Covers the
 * round-trip plus the three fail-loud paths the design requires.
 */

const dirs: string[] = [];
function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-secrets-"));
  dirs.push(dir);
  return join(dir, "secrets.enc.json");
}

afterEach(() => {
  // Temp dirs are OS-cleaned; nothing sensitive persists beyond the run.
});

describe("EncryptedFileStore", () => {
  it("round-trips secrets and lists/deletes them", async () => {
    const path = tmpStorePath();
    const store = new EncryptedFileStore(path, "correct horse battery staple");

    await store.set("openai", "sk-secret-1");
    await store.set("groq", "gsk-secret-2");

    expect(await store.get("openai")).toBe("sk-secret-1");
    expect(await store.get("groq")).toBe("gsk-secret-2");
    expect(await store.list()).toEqual(["groq", "openai"]);

    await store.delete("openai");
    expect(await store.get("openai")).toBeUndefined();
    expect(await store.list()).toEqual(["groq"]);
  });

  it("persists across store instances with the same passphrase", async () => {
    const path = tmpStorePath();
    await new EncryptedFileStore(path, "pw").set("openai", "sk-abc");
    const reopened = new EncryptedFileStore(path, "pw");
    expect(await reopened.get("openai")).toBe("sk-abc");
  });

  it("never writes the plaintext key to disk", async () => {
    const path = tmpStorePath();
    await new EncryptedFileStore(path, "pw").set("openai", "sk-PLAINTEXT-LEAK-CHECK");
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain("sk-PLAINTEXT-LEAK-CHECK");
    expect(onDisk).toContain("aes-256-gcm");
  });

  it("fails loudly on the wrong passphrase (does NOT return empty data)", async () => {
    const path = tmpStorePath();
    await new EncryptedFileStore(path, "right-pw").set("openai", "sk-abc");
    const wrong = new EncryptedFileStore(path, "wrong-pw");
    await expect(wrong.get("openai")).rejects.toThrow(/wrong RELAY_PASSPHRASE|corrupted/i);
  });

  it("fails loudly if the ciphertext is tampered with", async () => {
    const path = tmpStorePath();
    await new EncryptedFileStore(path, "pw").set("openai", "sk-abc");
    const file = JSON.parse(readFileSync(path, "utf8"));
    const bytes = Buffer.from(file.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 0xff; // flip a bit
    file.ciphertext = bytes.toString("base64");
    writeFileSync(path, JSON.stringify(file));
    await expect(new EncryptedFileStore(path, "pw").get("openai")).rejects.toThrow();
  });
});

describe("openSecretStore fallback", () => {
  it("refuses to open the file store without a passphrase when required", async () => {
    await expect(
      openSecretStore({ preferKeychain: false, passphrase: "", required: true }),
    ).rejects.toThrow(/RELAY_PASSPHRASE/);
  });

  it("returns null (env-only) when not required and no passphrase", async () => {
    const store = await openSecretStore({ preferKeychain: false, passphrase: "" });
    expect(store).toBeNull();
  });

  it("opens the encrypted-file backend when a passphrase is provided", async () => {
    const store = await openSecretStore({
      preferKeychain: false,
      passphrase: "pw",
      filePath: tmpStorePath(),
    });
    expect(store?.backend).toBe("encrypted-file");
  });
});
