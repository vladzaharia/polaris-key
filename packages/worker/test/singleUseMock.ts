/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../src/platform/env.js";
import { SingleUseDO } from "../src/singleUseDo.js";
import {
  consumeArtefact,
  deleteArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../src/core/singleUse.js";
import { StorageMock } from "./updateHealthMock.js";

// An in-memory DurableObjectNamespace that runs the REAL SingleUseDO class (as `rlMock.ts` does
// for the limiter) over the storage mock `updateHealthMock.ts` defines. Each object's fetches
// are serialised, modelling the input gate, so the atomicity tests here exercise the same
// one-request-at-a-time property the runtime gives (the workerd lane proves it on the real one).

export class SingleUseNamespaceMock {
  readonly instances = new Map<
    string,
    { obj: SingleUseDO; storage: StorageMock }
  >();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Make every fetch throw (an unreachable store). */
  failing = false;
  /** Every storage key any operation named, including keys deleted since (R12-04 tests). */
  readonly touched = new Set<string>();

  idFromName(name: string): DurableObjectId {
    return { name } as unknown as DurableObjectId;
  }

  instance(name: string) {
    let inst = this.instances.get(name);
    if (!inst) {
      const storage = new StorageMock();
      inst = {
        storage,
        obj: new SingleUseDO(
          { storage } as unknown as DurableObjectState,
          {} as Env,
        ),
      };
      this.instances.set(name, inst);
    }
    return inst;
  }

  get(id: DurableObjectId): {
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
  } {
    const name = (id as unknown as { name: string }).name;
    return {
      fetch: (input: string, init?: RequestInit) => {
        if (this.failing) return Promise.reject(new Error("DO reset"));
        try {
          const key = (JSON.parse(String(init?.body)) as { key?: unknown }).key;
          if (typeof key === "string") this.touched.add(key);
        } catch {
          // not an operation body; the object answers 400
        }
        const { obj } = this.instance(name);
        const run = (): Promise<Response> =>
          obj.fetch(new Request(input, init) as unknown as Request);
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

  /** Seconds left on the artefact at `ref`, rounded, or undefined when absent. */
  ttlOf(ref: ArtefactRef): number | undefined {
    const key = `${ref.kind}:${ref.id}`;
    for (const { storage } of this.instances.values()) {
      const rec = storage.m.get(key) as { exp: number } | undefined;
      if (rec) return Math.round((rec.exp - Date.now()) / 1000);
    }
    return undefined;
  }

  /** Every storage key across every object (test introspection). */
  keys(): string[] {
    return [...this.instances.values()].flatMap(({ storage }) => [
      ...storage.m.keys(),
    ]);
  }
}

export function makeSingleUseNamespace(): DurableObjectNamespace {
  return new SingleUseNamespaceMock() as unknown as DurableObjectNamespace;
}

/** The mock behind `env.SINGLE_USE` (for introspection). */
export function singleUseMock(env: Env): SingleUseNamespaceMock {
  return env.SINGLE_USE as unknown as SingleUseNamespaceMock;
}

/**
 * A KV-shaped facade over the single-use store, for tests that plant or inspect a flow record
 * by its address (`flowKey`, `deviceFlowKey`, `portalMagicKey`, …). `put` takes the same
 * `expirationTtl` option KV did (default 600 s).
 */
export function artefacts(env: Env) {
  return {
    get: (ref: ArtefactRef) => getArtefact(env, ref),
    put: async (
      ref: ArtefactRef,
      value: string,
      opts?: { expirationTtl?: number },
    ) => {
      await putArtefact(env, ref, value, opts?.expirationTtl ?? 600);
    },
    delete: (ref: ArtefactRef) => deleteArtefact(env, ref),
    consume: (ref: ArtefactRef) => consumeArtefact(env, ref),
  };
}
