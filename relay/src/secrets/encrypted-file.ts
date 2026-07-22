import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { SecretStore } from "./store.js";

/**
 * Passphrase-encrypted key store.
 *
 *   KDF    : scrypt (N=2^15, r=8, p=1) → 32-byte key, per-write random salt.
 *   Cipher : AES-256-GCM with a per-write random 12-byte IV; the GCM auth tag
 *            makes a wrong passphrase or any tampering fail closed on decrypt.
 *
 * The whole secret map is encrypted as one blob and rewritten on each change.
 * A wrong passphrase surfaces as a clear error, never as silently-empty data.
 */

const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
// scrypt needs ~128*N*r bytes (~32 MiB here); give it headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const FileShape = z.object({
  version: z.literal(1),
  kdf: z.object({
    algo: z.literal("scrypt"),
    N: z.number(),
    r: z.number(),
    p: z.number(),
    salt: z.string(),
  }),
  cipher: z.literal("aes-256-gcm"),
  iv: z.string(),
  authTag: z.string(),
  ciphertext: z.string(),
});

type SecretMap = Record<string, string>;

export class EncryptedFileStore implements SecretStore {
  readonly backend = "encrypted-file" as const;

  constructor(
    private readonly filePath: string,
    private readonly passphrase: string,
  ) {
    if (!passphrase) {
      throw new Error("EncryptedFileStore requires a non-empty passphrase.");
    }
  }

  private deriveKey(salt: Buffer, params = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }): Buffer {
    return scryptSync(this.passphrase, salt, KEY_LEN, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });
  }

  private load(): SecretMap {
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (err) {
      throw new Error(
        `Key store ${this.filePath} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const file = FileShape.safeParse(parsed);
    if (!file.success) {
      throw new Error(`Key store ${this.filePath} has an unexpected format.`);
    }
    const { kdf, iv, authTag, ciphertext } = file.data;
    const key = this.deriveKey(Buffer.from(kdf.salt, "base64"), kdf);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch {
      throw new Error(
        `Could not decrypt ${this.filePath}: wrong RELAY_PASSPHRASE or the store is corrupted.`,
      );
    }
    return JSON.parse(plain.toString("utf8")) as SecretMap;
  }

  private save(map: SecretMap): void {
    const salt = randomBytes(16);
    const key = this.deriveKey(salt);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(map), "utf8")),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const out = {
      version: 1 as const,
      kdf: {
        algo: "scrypt" as const,
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        salt: salt.toString("base64"),
      },
      cipher: "aes-256-gcm" as const,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    // 0o600: readable/writable by owner only.
    writeFileSync(this.filePath, JSON.stringify(out, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async get(providerId: string): Promise<string | undefined> {
    return this.load()[providerId];
  }

  async set(providerId: string, secret: string): Promise<void> {
    const map = this.load();
    map[providerId] = secret;
    this.save(map);
  }

  async delete(providerId: string): Promise<void> {
    const map = this.load();
    if (providerId in map) {
      delete map[providerId];
      this.save(map);
    }
  }

  async list(): Promise<string[]> {
    return Object.keys(this.load()).sort();
  }
}
