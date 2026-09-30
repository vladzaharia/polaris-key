// The TypeScript transcript replay engine (P1b-03, PARITY §4.2).
//
// A transcript (`conformance/transcripts/<id>.json`, recorded by the Worker's scenario tests)
// pins one conversation between a client and the Worker. This module is the fake server an SDK
// is pointed at while it replays one: it serves the recorded responses and asserts every
// request the SDK makes against the recording. The Node runner (`transcripts.test.ts`) and the
// React suite (`packages/sdk-react/test/transcripts.test.ts`) both drive it; Python and Swift
// carry ports of the same rules (`sdks/python/tests/transcript_replay.py`,
// `sdks/swift/Tests/PolarisKeyTests/TranscriptReplay.swift`). The format itself is documented
// once, in `packages/worker/test/transcripts/format.ts`.
//
// The engine never throws out of `fetch`: an SDK is entitled to swallow a transport error (a
// best-effort report does exactly that), so a thrown mismatch could vanish. Every problem is
// RECORDED instead and answered with a 599, and `endStep()` fails the test with the full list.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RequestBody {
  json: JsonValue;
  match: "exact" | "subset" | "shape";
  allowedKeys?: string[];
}

export interface Exchange {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    requiredHeaders: string[];
    body: RequestBody | null;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string | JsonValue;
  };
  capture?: Record<string, string>;
}

export interface Step {
  action: string;
  note?: string;
  args: Record<string, JsonValue>;
  now?: number;
  exchanges: { ordered: boolean; items: Exchange[] };
  expect: Record<string, JsonValue>;
}

export interface Transcript {
  transcriptVersion: number;
  id: string;
  description: string;
  features: string[];
  requires: string[];
  product: string;
  baseUrl: string;
  now: number;
  trust: Record<string, string>;
  initial: {
    deviceId: string;
    token?: string;
    version: string;
    services?: string[];
  };
  steps: Step[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..", "..");
export const TRANSCRIPTS_DIR = join(REPO_ROOT, "conformance", "transcripts");

/** Every committed transcript, in file-name order. */
export function loadTranscripts(dir = TRANSCRIPTS_DIR): Transcript[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Transcript);
}

export interface ParityManifest {
  features: Record<string, { status: "implemented" | "na" | "planned" }>;
}

export function loadManifest(repoRelative: string): ParityManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, repoRelative), "utf8"),
  ) as ParityManifest;
}

/**
 * Does this SDK replay this transcript? Every feature it proves must be `implemented`, and none
 * of the features it presupposes may be `na` (a runtime without a credential store never has a
 * device-token conversation at all). `pnpm parity:check` applies the same rule.
 */
export function applies(t: Transcript, manifest: ParityManifest): boolean {
  return (
    t.features.every((id) => manifest.features[id]?.status === "implemented") &&
    t.requires.every((id) => manifest.features[id]?.status !== "na")
  );
}

// ── Body matching ──────────────────────────────────────────────────────────────────────────

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeOf(v) === "object";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return a === b;
}

/** Problems with `actual` under `mode`, as `$.path: message` strings. */
export function bodyProblems(
  expected: JsonValue,
  actual: unknown,
  mode: RequestBody["match"],
  path = "$",
): string[] {
  if (mode === "exact")
    return deepEqual(expected, actual)
      ? []
      : [
          `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        ];
  if (isObject(expected)) {
    if (!isObject(actual))
      return [`${path}: expected an object, got ${typeOf(actual)}`];
    const out: string[] = [];
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in actual)) out.push(`${path}.${k}: missing`);
      else out.push(...bodyProblems(v, actual[k], mode, `${path}.${k}`));
    }
    return out;
  }
  if (mode === "shape")
    return typeOf(expected) === typeOf(actual)
      ? []
      : [`${path}: expected a ${typeOf(expected)}, got ${typeOf(actual)}`];
  return deepEqual(expected, actual)
    ? []
    : [
        `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      ];
}

// ── The server ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

export interface ArrivedRequest {
  method: string;
  /** Path and query, relative to the transcript's origin. */
  path: string;
  /** Lowercased names. */
  headers: Record<string, string>;
  body: string | null;
}

export class ReplayServer {
  /** The client state placeholders resolve against, as the conversation stands. */
  readonly bindings: Record<string, string> = {};
  readonly failures: string[] = [];
  private step: Step | null = null;
  private stepIndex = -1;
  private served: boolean[] = [];

  constructor(readonly transcript: Transcript) {
    this.bindings.deviceId = transcript.initial.deviceId;
    this.bindings.version = transcript.initial.version;
    if (transcript.initial.token)
      this.bindings.token = transcript.initial.token;
  }

  beginStep(index: number): Step {
    const step = this.transcript.steps[index];
    if (!step) throw new Error(`${this.transcript.id}: no step ${index}`);
    this.step = step;
    this.stepIndex = index;
    this.served = step.exchanges.items.map(() => false);
    for (const [k, v] of Object.entries(step.args))
      if (typeof v === "string") this.bindings[k] = v;
    return step;
  }

  /** Throw with every problem the step produced, including requests it never sent. */
  endStep(): void {
    const step = this.step;
    if (step) {
      step.exchanges.items.forEach((item, i) => {
        if (!this.served[i])
          this.failures.push(
            `expected request not sent: ${item.request.method} ${item.request.path}`,
          );
      });
    }
    this.step = null;
    if (this.failures.length) {
      const where = `${this.transcript.id} step ${this.stepIndex} (${step?.action ?? "?"})`;
      const all = this.failures.splice(0).join("\n  ");
      throw new Error(`${where}:\n  ${all}`);
    }
  }

  private substitute(template: string): { value?: string; unbound?: string } {
    let unbound: string | undefined;
    const value = template.replace(PLACEHOLDER, (_, name: string) => {
      const bound = this.bindings[name];
      if (bound === undefined) {
        unbound = name;
        return "";
      }
      return bound;
    });
    return unbound ? { unbound } : { value };
  }

  /** Why `req` does not satisfy `item`; empty when it does. */
  problems(item: Exchange, req: ArrivedRequest): string[] {
    const out: string[] = [];
    const expected = item.request;
    for (const [name, template] of Object.entries(expected.headers)) {
      const { value, unbound } = this.substitute(template);
      const actual = req.headers[name.toLowerCase()];
      if (unbound)
        out.push(
          `header ${name}: sent before {${unbound}} was bound (an earlier response it depends on)`,
        );
      else if (actual === undefined) out.push(`header ${name}: missing`);
      else if (actual !== value)
        out.push(
          `header ${name}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`,
        );
    }
    for (const name of expected.requiredHeaders)
      if (req.headers[name.toLowerCase()] === undefined)
        out.push(`required header ${name}: missing`);
    const hasBody = req.body !== null && req.body.length > 0;
    if (expected.body === null) {
      if (hasBody)
        out.push(`body: expected none, got ${req.body!.slice(0, 120)}`);
    } else if (!hasBody) {
      out.push("body: expected a JSON body, got none");
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body!);
      } catch {
        out.push("body: not JSON");
        return out;
      }
      out.push(
        ...bodyProblems(expected.body.json, parsed, expected.body.match).map(
          (p) => `body ${p}`,
        ),
      );
      if (expected.body.allowedKeys && isObject(parsed)) {
        const allowed = new Set(expected.body.allowedKeys);
        for (const k of Object.keys(parsed))
          if (!allowed.has(k)) out.push(`body: key "${k}" is not allowed`);
      }
    }
    return out;
  }

  /** Match an arrived request; returns the exchange to serve, or null (recorded as a failure). */
  handle(req: ArrivedRequest): Exchange | null {
    const step = this.step;
    const label = `${req.method} ${req.path}`;
    if (!step) {
      this.failures.push(`unexpected request outside a step: ${label}`);
      return null;
    }
    const items = step.exchanges.items;
    let candidates = items
      .map((item, i) => ({ item, i }))
      .filter(
        ({ item, i }) =>
          !this.served[i] &&
          item.request.method === req.method &&
          item.request.path === req.path,
      );
    if (step.exchanges.ordered) {
      const next = this.served.indexOf(false);
      candidates = candidates.filter(({ i }) => i === next);
    }
    if (!candidates.length) {
      this.failures.push(`unexpected request: ${label}`);
      return null;
    }
    for (const { item, i } of candidates) {
      if (this.problems(item, req).length) continue;
      this.served[i] = true;
      this.capture(item);
      return item;
    }
    const first = candidates[0]!;
    this.failures.push(
      `request ${label} does not match the recording:\n    ${this.problems(first.item, req).join("\n    ")}`,
    );
    return null;
  }

  private capture(item: Exchange): void {
    if (!item.capture) return;
    for (const [name, path] of Object.entries(item.capture)) {
      let cur: unknown = item.response.body;
      for (const part of path.replace(/^\$\./, "").split("."))
        cur = isObject(cur) ? cur[part] : undefined;
      if (typeof cur === "string") this.bindings[name] = cur;
      else this.failures.push(`capture ${name} (${path}) found no string`);
    }
  }

  /** The recorded response body as the bytes to serve. */
  static bodyText(item: Exchange): string {
    const b = item.response.body;
    return typeof b === "string" ? b : JSON.stringify(b);
  }

  /** A WHATWG `fetch` bound to this server. */
  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const origin = new URL(this.transcript.baseUrl).origin;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? null
        : await request.text();
    if (url.origin !== origin) {
      this.failures.push(`request to a foreign origin: ${url.href}`);
      return new Response("replay: foreign origin", { status: 599 });
    }
    const item = this.handle({
      method: request.method.toUpperCase(),
      path: url.pathname + url.search,
      headers,
      body,
    });
    if (!item)
      return new Response("replay: no matching exchange", { status: 599 });
    const text = ReplayServer.bodyText(item);
    const nullBody = [101, 204, 205, 304].includes(item.response.status);
    return new Response(nullBody || text === "" ? null : text, {
      status: item.response.status,
      headers: item.response.headers,
    });
  };
}

/** A copy of `t` with one step's exchanges edited — the doctored transcripts the negative
 *  tests use to prove a replayer fails. */
export function doctor(
  t: Transcript,
  stepIndex: number,
  edit: (items: Exchange[]) => Exchange[],
): Transcript {
  const copy = JSON.parse(JSON.stringify(t)) as Transcript;
  const step = copy.steps[stepIndex]!;
  step.exchanges.items = edit(step.exchanges.items);
  return copy;
}
