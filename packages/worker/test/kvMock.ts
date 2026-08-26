/// <reference types="@cloudflare/workers-types" />

/** A minimal in-memory KV used by tests (only the get/put/delete the worker uses). */
export class KvMock {
  private store = new Map<string, string>();
  private ttls = new Map<string, number | undefined>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
    this.ttls.set(key, options?.expirationTtl);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.ttls.delete(key);
  }
  /** Test introspection. */
  keys(): string[] {
    return [...this.store.keys()];
  }
  /** Test introspection: the `expirationTtl` a key was written with, if any (R10-12). */
  ttlOf(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

export function asKv(mock: KvMock): KVNamespace {
  return mock as unknown as KVNamespace;
}
