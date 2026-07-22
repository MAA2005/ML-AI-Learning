import { resolve } from "node:path";
import { EncryptedFileStore } from "./encrypted-file.js";
import { tryOpenKeychain } from "./keychain.js";

/**
 * Storage for provider API keys. Two backends, in priority order:
 *
 *   1. keychain      — the OS keychain (macOS Keychain, Windows Credential
 *                      Vault, libsecret) via the optional `keytar` dependency.
 *   2. encrypted-file — AES-256-GCM over a scrypt-derived key, unlocked by an
 *                      explicit passphrase (RELAY_PASSPHRASE). This is the
 *                      *strong* fallback, not a degraded one: no passphrase means
 *                      no store, and we say so loudly rather than writing keys in
 *                      the clear.
 *
 * Keys are never written to config files, logs, or the .env — only here.
 */
export interface SecretStore {
  readonly backend: "keychain" | "encrypted-file";
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, secret: string): Promise<void>;
  delete(providerId: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface OpenStoreOptions {
  /** Encrypted-file path; defaults to `.relay/secrets.enc.json` under cwd. */
  filePath?: string;
  /** Passphrase for the encrypted file; defaults to env RELAY_PASSPHRASE. */
  passphrase?: string;
  /** Skip the keychain probe (used to force/test the file backend). */
  preferKeychain?: boolean;
  /** Keychain service name. */
  serviceName?: string;
  /**
   * When true (e.g. `relay add-provider`, which must persist a key), throw with
   * a clear message if no backend can be opened. When false (startup read),
   * return null so env-only dev keeps working.
   */
  required?: boolean;
}

export function defaultStorePath(): string {
  return resolve(process.cwd(), ".relay", "secrets.enc.json");
}

export async function openSecretStore(
  opts: OpenStoreOptions = {},
): Promise<SecretStore | null> {
  // RELAY_KEY_BACKEND=file forces the encrypted-file store, skipping the OS
  // keychain (useful when you'd rather not touch the system credential vault).
  const forceFile =
    opts.preferKeychain === false || process.env.RELAY_KEY_BACKEND === "file";

  if (!forceFile) {
    const kc = await tryOpenKeychain(opts.serviceName ?? "relay-gateway");
    if (kc) return kc;
  }

  const passphrase = opts.passphrase ?? process.env.RELAY_PASSPHRASE;
  if (passphrase && passphrase.length > 0) {
    return new EncryptedFileStore(opts.filePath ?? defaultStorePath(), passphrase);
  }

  if (opts.required) {
    throw new Error(
      "No OS keychain is available and RELAY_PASSPHRASE is not set.\n" +
        "Set RELAY_PASSPHRASE to unlock the encrypted key store — keys are never " +
        "stored unencrypted, and Relay will not silently fall back to anything weaker.",
    );
  }
  return null;
}
