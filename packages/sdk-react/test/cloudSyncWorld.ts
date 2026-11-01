// The fake Worker /sync routes, Web Locks and tab channel the browser Cloud Sync tests share.

import type {
  TabChannel,
  TabMessage,
} from "../src/browser/cloudSync/writer.js";

export const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";
export type Body = Record<string, unknown>;

export class World {
  pushes: Body[] = [];
  /** The token each request carried, and its body. */
  tokens: Array<{ token: string; body: string }> = [];
  version = 100;
  pull: () => Body = () => this.body();
  push: (b: Body) => Response | Body = (b) => ({
    results: (b.mutations as Array<{ mutationId: number }>).map((m) => ({
      mutationId: m.mutationId,
      status: "ok",
      version: ++this.version,
    })),
  });
  body(over: Body = {}): Body {
    return {
      subject: SUBJECT,
      serverNow: 1_700_000_000_000,
      cursor: 0,
      more: false,
      lastMutationId: 0,
      catalogVersion: 1,
      aliases: {},
      usage: { files: 0, records: 0, settings: 0, bytes: 0 },
      quota: { files: true, bytes: 2 ** 28 },
      encryption: "server",
      encryptionSince: 1,
      changes: [],
      tombstones: [],
      ...over,
    };
  }
  request = async (
    path: string,
    init: { method: string; body?: string },
  ): Promise<Response> => {
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    const wrap = (r: Response | Body) => (r instanceof Response ? r : json(r));
    if (path.startsWith("sync/ops") && init.method === "POST") {
      const body = JSON.parse(init.body!) as Body;
      this.pushes.push(body);
      return wrap(this.push(body));
    }
    if (path.startsWith("sync") && init.method === "GET")
      return wrap(this.pull());
    return json({}, 404);
  };
}

export class Locks {
  private held = new Set<string>();
  private queues = new Map<string, Array<() => void>>();
  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as {
      ifAvailable?: boolean;
    };
    const fn = (typeof a === "function" ? a : b) as (
      l: unknown,
    ) => Promise<unknown> | unknown;
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.held.add(name);
        try {
          resolve(await fn({ name }));
        } catch (e) {
          reject(e);
        } finally {
          this.held.delete(name);
          this.queues.get(name)?.shift()?.();
        }
      };
      if (!this.held.has(name)) void run();
      else if (opts.ifAvailable)
        Promise.resolve(fn(null)).then(resolve, reject);
      else {
        const q = this.queues.get(name) ?? [];
        q.push(() => void run());
        this.queues.set(name, q);
      }
    });
  }
}

export class Hub {
  private members = new Set<{ deliver: (m: TabMessage) => void }>();
  channel(): TabChannel {
    const handlers: Array<(m: TabMessage) => void> = [];
    const me = { deliver: (m: TabMessage) => handlers.forEach((h) => h(m)) };
    this.members.add(me);
    return {
      post: (m) => {
        const copy = structuredClone(m);
        for (const o of this.members)
          if (o !== me) setTimeout(() => o.deliver(copy), 0);
      },
      onMessage: (fn) => void handlers.push(fn),
      close: () => void this.members.delete(me),
    };
  }
}
