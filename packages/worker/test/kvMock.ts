/// <reference types="@cloudflare/workers-types" />

/** A minimal in-memory KV used by tests (only the get/put/delete the worker uses). */
export class KvMock {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  /** Test introspection. */
  keys(): string[] {
    return [...this.store.keys()];
  }
}

export function asKv(mock: KvMock): KVNamespace {
  return mock as unknown as KVNamespace;
}
