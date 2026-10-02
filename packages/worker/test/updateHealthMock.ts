/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../src/env.js";
import { UpdateHealthDO } from "../src/updateHealthDo.js";

// An in-memory DurableObjectNamespace that runs the REAL UpdateHealthDO class (like `rlMock.ts`
// does for the limiter) against a storage map with the subset of the Durable Object storage API
// the class uses: get, put, delete, list (prefix/start/end/limit, key-ordered), deleteAll and
// the alarm. Each object's fetches are serialised, modelling the input gate.

export class StorageMock {
  readonly m = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.m.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.m.set(key, structuredClone(value));
  }
  async delete(keys: string | string[]): Promise<number> {
    let n = 0;
    for (const k of Array.isArray(keys) ? keys : [keys])
      if (this.m.delete(k)) n++;
    return n;
  }
  async deleteAll(): Promise<void> {
    this.m.clear();
  }
  async list<T>(
    opts: {
      prefix?: string;
      start?: string;
      end?: string;
      limit?: number;
    } = {},
  ): Promise<Map<string, T>> {
    const keys = [...this.m.keys()]
      .filter(
        (k) =>
          (opts.prefix === undefined || k.startsWith(opts.prefix)) &&
          (opts.start === undefined || k >= opts.start) &&
          (opts.end === undefined || k < opts.end),
      )
      .sort();
    const out = new Map<string, T>();
    for (const k of keys.slice(0, opts.limit ?? keys.length))
      out.set(k, this.m.get(k) as T);
    return out;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
}

export class UpdateHealthNamespaceMock {
  readonly instances = new Map<
    string,
    { obj: UpdateHealthDO; storage: StorageMock }
  >();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Calls per object name, for the "one call per release" assertions. */
  readonly calls: string[] = [];
  /** Make the next fetches throw (a DO reset or overload). */
  failing = false;

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  instance(name: string) {
    let inst = this.instances.get(name);
    if (!inst) {
      const storage = new StorageMock();
      inst = {
        storage,
        obj: new UpdateHealthDO(
          { storage } as unknown as DurableObjectState,
          {} as Env,
        ),
      };
      this.instances.set(name, inst);
    }
    return inst;
  }

  get(id: DurableObjectId) {
    const name = (id as unknown as { name: string }).name;
    return {
      fetch: (input: string, init?: RequestInit): Promise<Response> => {
        this.calls.push(name);
        if (this.failing) return Promise.reject(new Error("object reset"));
        const target = this.instance(name).obj;
        const run = () => target.fetch(new Request(input, init));
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

export function makeUpdateHealthNamespace(): UpdateHealthNamespaceMock {
  return new UpdateHealthNamespaceMock();
}

export function asNamespace(
  m: UpdateHealthNamespaceMock,
): DurableObjectNamespace {
  return m as unknown as DurableObjectNamespace;
}
