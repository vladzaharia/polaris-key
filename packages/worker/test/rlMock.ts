/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../src/env.js";
import { RateLimitDO } from "../src/rateLimitDo.js";

// A faithful in-memory DurableObjectNamespace that runs the REAL RateLimitDO class against an
// in-memory storage map, so tests exercise the production limiter logic (not a reimplementation).

class StorageMock {
  private m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.m.set(key, value);
  }
}

class StateMock {
  storage = new StorageMock();
}

class RlNamespaceMock {
  private readonly instances = new Map<string, RateLimitDO>();
  // Per-instance serialization, modeling a real DO's single-threaded input gate so that
  // concurrent fetches can't interleave their storage read/write (the property D6 fixes).
  private readonly tails = new Map<string, Promise<unknown>>();

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
  } {
    const name = (id as unknown as { name: string }).name;
    let inst = this.instances.get(name);
    if (!inst) {
      inst = new RateLimitDO(
        new StateMock() as unknown as DurableObjectState,
        {} as Env,
      );
      this.instances.set(name, inst);
    }
    const target = inst;
    return {
      fetch: (input: string, init?: RequestInit) => {
        const run = (): Promise<Response> =>
          target.fetch(new Request(input, init) as unknown as Request);
        const prior = this.tails.get(name) ?? Promise.resolve();
        const result = prior.then(run, run);
        this.tails.set(
          name,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      },
    };
  }
}

export function makeRlNamespace(): DurableObjectNamespace {
  return new RlNamespaceMock() as unknown as DurableObjectNamespace;
}
