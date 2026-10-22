/**
 * The write engine both apps share: a table says, per API method, which queries a confirmed write
 * makes stale, and `mutate` makes the write and then applies it, so a view cannot forget one.
 * Each app keeps its own table (`console/data/mutations.ts`, `portal/mutations.ts`) and builds its
 * engine with {@link createWrites}.
 *
 * Confirmed, never optimistic: a refused write changes nothing in the cache.
 *
 * Imports nothing local (`test/boundaries.test.ts`, rule 1).
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";

/** One cache target: a key prefix, or one exact key. */
export interface Target {
  key: QueryKey;
  exact?: boolean;
}

/** What one write does to the cache. */
export interface WriteSpec<A extends unknown[]> {
  /** What the write does, for the table's readers and the tests' failure messages. */
  label: string;
  /** The queries the write makes stale: refetched in the background. */
  invalidates: (...args: A) => Target[];
  /** Queries the write makes meaningless (a deleted record's view): dropped from the cache. */
  removes?: (...args: A) => Target[];
  /**
   * Queries the write only resolves after they have refetched (the claim that must find the
   * product in the library when the page moves on). Invalidated like `invalidates`, and awaited.
   */
  settle?: (...args: A) => Target[];
  /** Required when the entry changes nothing in the cache: say why that is right. */
  why?: string;
}

type AnyFn = (...args: never[]) => Promise<unknown>;

/** A table: a spec per write method of `Api`. */
export type WriteTable<
  Api extends Record<string, AnyFn>,
  K extends keyof Api,
> = {
  [M in K]: WriteSpec<Parameters<Api[M]>>;
};

export interface WritesConfig<
  Api extends Record<string, AnyFn>,
  K extends keyof Api & string,
> {
  table: WriteTable<Api, K>;
  /** The API object whose methods the table names. */
  api: Api;
  /** Runs when a write is refused, before the error is thrown to the caller. */
  onError?: (error: unknown, clients: ReadonlySet<QueryClient>) => void;
}

export interface Writes<
  Api extends Record<string, AnyFn>,
  K extends keyof Api & string,
> {
  /** The cache targets a write invalidates, or `null` when `method` is not a write. */
  invalidationFor(method: string, args: unknown[]): Target[] | null;
  /** Bind a client to the non-hook path (`invalidateAfter`, `mutate` without a client). */
  bindWriteInvalidation(client: QueryClient): () => void;
  /** Apply a confirmed write's declaration to the bound clients. */
  invalidateAfter(method: K, args: unknown[]): Promise<void>;
  /** Make a write; once the server confirms, apply its declaration. */
  mutate<M extends K>(
    method: M,
    ...args: Parameters<Api[M]>
  ): Promise<Awaited<ReturnType<Api[M]>>>;
  /** One write per argument list, then one declaration applied (a bulk change refetches once). */
  mutateEach<M extends K>(
    method: M,
    argLists: Parameters<Api[M]>[],
  ): Promise<(Error | null)[]>;
  /** `mutate` as a TanStack mutation on the surrounding client; the variables are the arguments. */
  useWrite<M extends K>(
    method: M,
  ): UseMutationResult<Awaited<ReturnType<Api[M]>>, Error, Parameters<Api[M]>>;
}

export function createWrites<
  Api extends Record<string, AnyFn>,
  K extends keyof Api & string,
>(config: WritesConfig<Api, K>): Writes<Api, K> {
  const specs = config.table as unknown as Record<string, WriteSpec<unknown[]>>;
  const bound = new Set<QueryClient>();

  const invalidationFor = (method: string, args: unknown[]) => {
    const spec = specs[method];
    return spec ? spec.invalidates(...args) : null;
  };

  /** Apply a spec to `clients`: remove, invalidate, then wait for what the write settles on. */
  async function apply(
    method: string,
    args: unknown[],
    clients: Iterable<QueryClient>,
  ): Promise<void> {
    const spec = specs[method];
    if (!spec) return;
    const removes = spec.removes?.(...args) ?? [];
    const invalidates = spec.invalidates(...args);
    const settle = spec.settle?.(...args) ?? [];
    const waiting: Promise<unknown>[] = [];
    for (const client of clients) {
      for (const t of removes)
        client.removeQueries({ queryKey: t.key, exact: t.exact });
      for (const t of invalidates)
        void client.invalidateQueries({ queryKey: t.key, exact: t.exact });
      for (const t of settle)
        waiting.push(
          client.invalidateQueries({ queryKey: t.key, exact: t.exact }),
        );
    }
    await Promise.all(waiting);
  }

  const fnOf = (method: string) =>
    config.api[method] as unknown as (...a: unknown[]) => Promise<unknown>;

  async function run(
    method: string,
    args: unknown[],
    clients: ReadonlySet<QueryClient>,
  ): Promise<unknown> {
    let result: unknown;
    try {
      result = await fnOf(method)(...args);
    } catch (e) {
      config.onError?.(e, clients);
      throw e;
    }
    await apply(method, args, clients);
    return result;
  }

  return {
    invalidationFor,
    bindWriteInvalidation(client) {
      bound.add(client);
      return () => {
        bound.delete(client);
      };
    },
    invalidateAfter: (method, args) => apply(method, args, bound),
    mutate: (async (method: string, ...args: unknown[]) =>
      run(method, args, bound)) as Writes<Api, K>["mutate"],
    async mutateEach(method, argLists) {
      const fn = fnOf(method);
      const outcomes: (Error | null)[] = [];
      let changed: unknown[] | null = null;
      for (const args of argLists) {
        try {
          await fn(...args);
          changed = args;
          outcomes.push(null);
        } catch (e) {
          outcomes.push(e instanceof Error ? e : new Error(String(e)));
        }
      }
      if (changed) await apply(method, changed, bound);
      return outcomes;
    },
    useWrite(method) {
      const client = useQueryClient();
      return useMutation({
        mutationFn: (args) =>
          run(method, args as unknown[], new Set([client])) as Promise<
            Awaited<ReturnType<Api[typeof method]>>
          >,
      });
    },
  } as Writes<Api, K>;
}
