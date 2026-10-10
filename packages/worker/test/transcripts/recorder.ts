/// <reference types="@cloudflare/workers-types" />
// The transcript recorder (P1b-03): drives a conversation through the REAL Worker router and
// writes down what an SDK must send and what the Worker answered.
//
// ── WHY THE SCENARIO WRITES THE REQUESTS ────────────────────────────────────────────────────
//
// The Worker's existing suites call handlers directly with `mkReq`, whose URL is always
// `https://key.plrs.im/x`, so their requests carry no real path and never touch routing — there
// is nothing to capture from them. A scenario therefore builds each request exactly as a client
// following the wire contract would (method, path, the seven `X-PKey-*` headers, the bearer, the
// conditional header, the body), sends it through `dispatchWith` — the production router,
// product loading, CORS and every service, at a pinned instant — and declares, next to it, which
// parts of that request a replaying SDK is held to. The response is recorded verbatim.
//
// ── WHAT IS ASSERTED, AND HOW ───────────────────────────────────────────────────────────────
//
//   * values that belong to the CLIENT'S STATE are recorded as placeholders — `{deviceId}`,
//     `{version}`, `{token}`, `{key}` — never as the literal the recorder happened to send, so
//     a replaying SDK is checked against its own state at the moment it sends;
//   * values the SERVER chose (an ETag) are recorded literally: the client must echo them;
//   * the seven metadata headers are asserted by presence (PARITY §11 Q2); the platform and
//     arch values are P1b-04's to pin;
//   * a body is asserted by the scenario's declared expectation (`expectBody`), not by the
//     literal bytes the recorder sent, because a fingerprint or a facts snapshot legitimately
//     differs per host.

import type { Env } from "../../src/platform/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";
import { dispatchWith } from "../../src/dispatch.js";
import { TEST_KID, TEST_PUB } from "../seed.js";
import type { KvMock } from "../kvMock.js";
import type { Pinned } from "./determinism.js";
import {
  METADATA_HEADERS,
  RECORDED_RESPONSE_HEADERS,
  TRANSCRIPT_VERSION,
  type Action,
  type Exchange,
  type JsonValue,
  type RecordedRequest,
  type RecordedResponse,
  type RequestBody,
  type Step,
  type Transcript,
} from "./format.js";

export const BASE_URL = "https://key.plrs.im";

/** The values the recorder sends for the metadata headers a transcript asserts by presence
 *  only. They are the recorder's own, not any SDK's; platform and arch are canonical
 *  WIRE-CONTRACT-V3 §5.2 values, and appear in a transcript only where a roster response echoes
 *  the stored device row. */
const RECORDER_METADATA = {
  "x-pkey-channel": "stable",
  "x-pkey-sdk": "pkey-transcript-recorder",
  "x-pkey-sdk-version": "1",
  "x-pkey-platform": "linux",
  "x-pkey-arch": "x86_64",
};

export interface World {
  db: SqliteDb;
  kv: KvMock;
  env: Env;
}

export interface ExchangeSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path (and query) under the origin, e.g. `/djdl/license/document`. */
  path: string;
  /** Send `Authorization: Bearer <binding>` and assert it as `Bearer {<binding>}`. */
  bearer?: "token" | "key";
  /** Send the seven metadata headers and require them. Defaults to true. */
  metadata?: boolean;
  /** Send `If-None-Match` and assert its (literal, server-chosen) value. */
  ifNoneMatch?: string;
  /** Extra headers SENT but not asserted (e.g. `accept`). */
  headers?: Record<string, string>;
  /** Headers SENT and asserted by VALUE (e.g. a chunk fetch's `range`, P4-32). */
  assertHeaders?: Record<string, string>;
  /** Headers SENT and asserted by PRESENCE only (added to `requiredHeaders`): a value the
   *  recorder must choose but no replaying SDK can reproduce, such as a stale `if-range`. */
  presentHeaders?: Record<string, string>;
  /** The JSON body actually sent. */
  body?: unknown;
  /** What a replaying SDK's body is held to. Required when `body` is set. */
  expectBody?: RequestBody;
  /** Bind values from the JSON response for later requests. */
  capture?: Record<string, string>;
  /**
   * The request is expected to THROW out of the Worker (a D1 outage). It is recorded as the
   * runtime's bare `500`: an uncaught exception never reaches `secureResponse`, and the page the
   * platform renders instead is not part of the contract, so nothing else of it is kept.
   */
  runtimeFailure?: boolean;
}

/** Read a `$.a.b` path out of a JSON value. */
function readPath(value: unknown, path: string): unknown {
  if (!path.startsWith("$.")) throw new Error(`capture path ${path}`);
  let cur: unknown = value;
  for (const part of path.slice(2).split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export class StepRecorder {
  readonly items: Exchange[] = [];

  constructor(
    private readonly recorder: TranscriptRecorder,
    readonly now: number,
    private readonly args: Record<string, JsonValue>,
  ) {}

  /** Send one request through the router, record the exchange, and hand back the response
   *  (re-readable) so the scenario can assert the SERVER's behaviour as an ordinary test. */
  async send(spec: ExchangeSpec): Promise<Response> {
    const bindings = this.recorder.bindings;
    const sent: Record<string, string> = { ...(spec.headers ?? {}) };
    const asserted: Record<string, string> = {};
    const metadata = spec.metadata !== false;
    if (metadata) {
      sent["x-pkey-device"] = bindings.deviceId!;
      sent["x-pkey-version"] = bindings.version!;
      Object.assign(sent, RECORDER_METADATA);
      asserted["x-pkey-device"] = "{deviceId}";
      asserted["x-pkey-version"] = "{version}";
    }
    if (spec.bearer) {
      const value =
        spec.bearer === "key"
          ? (this.args.key as string | undefined)
          : bindings.token;
      if (!value) throw new Error(`no ${spec.bearer} bound for ${spec.path}`);
      sent.authorization = `Bearer ${value}`;
      asserted.authorization = `Bearer {${spec.bearer}}`;
    }
    if (spec.ifNoneMatch !== undefined) {
      sent["if-none-match"] = spec.ifNoneMatch;
      asserted["if-none-match"] = spec.ifNoneMatch;
    }
    for (const [name, value] of Object.entries(spec.assertHeaders ?? {})) {
      sent[name.toLowerCase()] = value;
      asserted[name.toLowerCase()] = value;
    }
    for (const [name, value] of Object.entries(spec.presentHeaders ?? {}))
      sent[name.toLowerCase()] = value;
    let body: string | undefined;
    if (spec.body !== undefined) {
      if (!spec.expectBody)
        throw new Error(`${spec.path}: a body needs an expectBody`);
      sent["content-type"] = "application/json";
      body = JSON.stringify(spec.body);
    }

    const req = new Request(`${BASE_URL}${spec.path}`, {
      method: spec.method,
      headers: sent,
      ...(body !== undefined ? { body } : {}),
    }) as unknown as Request;

    let res: Response;
    if (spec.runtimeFailure) {
      let threw = false;
      try {
        await dispatchWith(
          req,
          this.recorder.world.env,
          this.recorder.world.db,
          this.now,
        );
      } catch {
        threw = true;
      }
      if (!threw) throw new Error(`${spec.path}: expected the Worker to throw`);
      res = new Response(null, { status: 500 });
    } else {
      res = await dispatchWith(
        req,
        this.recorder.world.env,
        this.recorder.world.db,
        this.now,
      );
    }

    const text = await res.text();
    const headers: Record<string, string> = {};
    for (const name of RECORDED_RESPONSE_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) headers[name] = v;
    }
    const isJson =
      text.length > 0 &&
      (res.headers.get("content-type") ?? "").includes("application/json");
    const responseBody: string | JsonValue = isJson
      ? (JSON.parse(text) as JsonValue)
      : text;

    const requiredHeaders: string[] = metadata ? [...METADATA_HEADERS] : [];
    if (body !== undefined) requiredHeaders.push("content-type");
    for (const name of Object.keys(spec.presentHeaders ?? {}))
      requiredHeaders.push(name.toLowerCase());
    const request: RecordedRequest = {
      method: spec.method,
      path: spec.path,
      headers: asserted,
      requiredHeaders,
      body: body !== undefined ? spec.expectBody! : null,
    };
    const response: RecordedResponse = {
      status: res.status,
      headers,
      body: responseBody,
    };
    const exchange: Exchange = { request, response };
    if (spec.capture) {
      exchange.capture = { ...spec.capture };
      for (const [name, path] of Object.entries(spec.capture)) {
        const value = readPath(responseBody, path);
        if (typeof value !== "string")
          throw new Error(
            `${spec.path}: capture ${name} (${path}) is not a string`,
          );
        bindings[name] = value;
      }
    }
    this.items.push(exchange);

    return new Response(text.length > 0 ? text : null, {
      status: res.status,
      headers: res.headers,
    });
  }
}

export interface RecorderOptions {
  id: string;
  description: string;
  features: string[];
  requires: string[];
  product: string;
  now: number;
  world: World;
  pinned: Pinned;
  initial: Transcript["initial"];
  /** The keys the client pins (`trust`); the corpus signing key when omitted. */
  trust?: Record<string, string>;
}

export interface StepSpec {
  action: Action;
  note?: string;
  args?: Record<string, JsonValue>;
  now?: number;
  ordered?: boolean;
}

export class TranscriptRecorder {
  readonly world: World;
  /** The client state placeholders resolve against, as the conversation stands. */
  readonly bindings: Record<string, string | undefined>;
  private readonly steps: Step[] = [];

  constructor(private readonly opts: RecorderOptions) {
    this.world = opts.world;
    this.bindings = {
      deviceId: opts.initial.deviceId,
      version: opts.initial.version,
      token: opts.initial.token,
    };
  }

  /** Record one SDK call. `drive` sends its requests; `expect` is the client-visible outcome a
   *  replaying SDK must report afterwards. */
  async step(
    spec: StepSpec,
    drive: (s: StepRecorder) => Promise<void>,
    expect: Record<string, JsonValue>,
  ): Promise<void> {
    const now = spec.now ?? this.opts.now;
    this.opts.pinned.setNow(now);
    const s = new StepRecorder(this, now, spec.args ?? {});
    await drive(s);
    const step: Step = {
      action: spec.action,
      ...(spec.note ? { note: spec.note } : {}),
      args: spec.args ?? {},
      ...(now !== this.opts.now ? { now } : {}),
      exchanges: { ordered: spec.ordered === true, items: s.items },
      expect,
    };
    this.steps.push(step);
  }

  transcript(): Transcript {
    const { id, description, features, requires, product, now, initial } =
      this.opts;
    return {
      transcriptVersion: TRANSCRIPT_VERSION,
      id,
      description,
      features,
      requires,
      product,
      baseUrl: BASE_URL,
      now,
      trust: this.opts.trust ?? { [TEST_KID]: TEST_PUB },
      initial,
      steps: this.steps,
    };
  }
}
