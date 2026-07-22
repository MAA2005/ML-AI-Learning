import type { SecretStore } from "./store.js";

/**
 * OS keychain backend via the optional `keytar` native module. `keytar` is an
 * optionalDependency: on machines where it failed to build/install, or where no
 * keychain daemon is present, this returns null and the caller falls back to the
 * encrypted-file store. We probe once to confirm the backend actually works
 * before committing to it.
 */

interface Keytar {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export async function tryOpenKeychain(service: string): Promise<SecretStore | null> {
  let keytar: Keytar;
  try {
    const mod = (await import("keytar")) as unknown as { default?: Keytar } & Keytar;
    keytar = mod.default ?? mod;
  } catch {
    return null; // module not installed / failed to load
  }
  try {
    // A no-op call that throws if the platform backend is unavailable.
    await keytar.findCredentials(service);
  } catch {
    return null;
  }
  return new KeychainStore(keytar, service);
}

class KeychainStore implements SecretStore {
  readonly backend = "keychain" as const;

  constructor(
    private readonly keytar: Keytar,
    private readonly service: string,
  ) {}

  async get(providerId: string): Promise<string | undefined> {
    return (await this.keytar.getPassword(this.service, providerId)) ?? undefined;
  }

  async set(providerId: string, secret: string): Promise<void> {
    await this.keytar.setPassword(this.service, providerId, secret);
  }

  async delete(providerId: string): Promise<void> {
    await this.keytar.deletePassword(this.service, providerId);
  }

  async list(): Promise<string[]> {
    const creds = await this.keytar.findCredentials(this.service);
    return creds.map((c) => c.account).sort();
  }
}
