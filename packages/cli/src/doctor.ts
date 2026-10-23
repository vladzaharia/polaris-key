/**
 * `pkey doctor`'s facts (P0-45): what the CLI can verify about this product, as data, so the
 * text and `--json` answers cannot differ. The facts are the CLI's twin of the console's
 * Integration verdict for the parts both can see without an SDK having called in:
 *
 *   manifest      `.pkey/` validates (a warning is a ▲, an error a ✗ to do)
 *   discovery     `<base-url>/<product>/.well-known/polaris.json` answers
 *   services      the services discovery says are enabled
 *   signing-keys  the signing keys discovery exposes
 *   in-sync       the manifest's features match the live product's (a ▲ with the fix when not)
 *
 * Two more answers need a sign-in (ST-34.10), both from the console API with the credential
 * `pkey login` saved (`adminCredential()`):
 *
 *   signedIn      who the credential is (`GET /me`) and when it ends; none is a ▲ warning with the
 *                 fix `pkey login`, never a to-do, so the exit code does not change because of it
 *   integration   ST-40's view (`GET /manage/api/products/<slug>/integration`): per feature and
 *                 platform ✓ Verified, ● Waiting or ○ Not seen yet, and the open console steps as
 *                 Left to do, each with its `/manage` deep link. A 403 is a ▲ warning too.
 *
 * Discovery, `/me`, the view and a 403's lookups share one deadline. Everything read from the
 * server is the server's words: callers clean it (`untrusted.ts`) before it reaches a terminal or
 * a job log. The text and `--json` are both drawn from the facts below.
 */

import {
  cellWidth,
  Painter,
  wrapSpans,
  type Line,
} from "@polaris-key/node/terminal";
import { day, glyphOf } from "./account.js";
import {
  accessInfo,
  accessText,
  type AccessInfo,
  type AdminIo,
} from "./adminAuth.js";
import { httpError, maskTokens, request } from "./bundle.js";
import {
  adminCredential,
  Refusal,
  type ResolvedCredential,
} from "./credentials.js";
import { readCappedText } from "./httpRead.js";
import { Redirected, Unreachable } from "./netErrors.js";
import type { ValidationResult } from "./manifest.js";
import type { Term } from "./terminal.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

/** One deadline for every request a doctor run makes. */
export const DOCTOR_TIMEOUT_MS = 15_000;

export type DoctorState = "ok" | "warn" | "todo";

export interface DoctorFact {
  id:
    | "manifest"
    | "discovery"
    | "services"
    | "signing-keys"
    | "config-file"
    | "in-sync";
  state: DoctorState;
  /** One plain sentence; for a remote fact it quotes the server, so it is cleaned on output. */
  detail: string;
  /** The one fix for a ▲ or ✗ fact: a bare command, or a short instruction. */
  fix?: string;
  /** A machine code for a failure with a name: `network` when the server could not be reached. */
  code?: string;
}

export interface RemoteDoctor {
  /** The discovery URL, with any pkey token in it masked: it is shown and put in `--json`. */
  url: string;
  host: string;
  /** The signing key ids discovery exposes, in the server's order (never the keys themselves). */
  keys: string[];
  /** Each key's id and status (`active`, `staged`, …) from `trust.keys`. */
  keyStates: Array<{ kid: string; status: string }>;
  /** The key ids an app pins today: the names in `trust.pinnedKeys`. */
  pinned: string[];
  /** The HTTP status when the server answered with a refusal. */
  status?: number;
  services: string[];
  signing: unknown;
  facts: DoctorFact[];
}

/**
 * A response's JSON through the shared 64 KiB cap (`httpRead.ts`). Unlike `readCappedJson`, a body
 * over the cap or not JSON throws, so discovery can report it as unreadable.
 */
export async function readCapped(res: Response): Promise<unknown> {
  const text = await readCappedText(res);
  if (text === null) throw new ReadFailure("too large or unreadable");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReadFailure("not JSON");
  }
}

/** The answer arrived but is not a readable JSON document (oversize, or not JSON). */
export class ReadFailure extends Error {
  constructor(why: string) {
    super(`The answer could not be read: ${why}.`);
    this.name = "ReadFailure";
  }
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/** The manifest fact from a validation, or from the reason no manifest could be read. */
export function manifestFact(
  result: ValidationResult | null,
  problem?: string,
  fileWarnings: readonly string[] = [],
): DoctorFact {
  if (!result)
    return {
      id: "manifest",
      state: "todo",
      detail: problem ?? "no .pkey/ manifest",
    };
  if (!result.ok)
    return {
      id: "manifest",
      state: "todo",
      detail: plural(result.errors.length, "error"),
    };
  const warnings = result.warnings.length + fileWarnings.length;
  return {
    id: "manifest",
    state: warnings ? "warn" : "ok",
    detail: warnings ? plural(warnings, "warning") : "valid",
    ...(hasFixable(result) ? { fix: VALIDATE_FIX } : {}),
  };
}

export const VALIDATE_FIX = "pkey validate --fix";

/** True when `pkey validate --fix` can repair a warning (a deprecated spelling). */
export const hasFixable = (result: ValidationResult): boolean =>
  result.warnings.some((w) => w.code === "deprecated_spelling");

/** Whether the manifest's features match the live product's; a ▲ naming the difference if not. */
export function syncFact(
  manifest: readonly string[],
  live: readonly string[],
): DoctorFact {
  const onlyManifest = manifest.filter((s) => !live.includes(s));
  const onlyLive = live.filter((s) => !manifest.includes(s));
  if (!onlyManifest.length && !onlyLive.length)
    return { id: "in-sync", state: "ok", detail: "matches" };
  const parts = [
    onlyManifest.length ? `only in .pkey/: ${onlyManifest.join(", ")}` : "",
    onlyLive.length ? `only live: ${onlyLive.join(", ")}` : "",
  ].filter(Boolean);
  return {
    id: "in-sync",
    state: "warn",
    detail: parts.join("; "),
    fix: "Resync the product from .pkey/ in the console.",
  };
}

/** The host of a URL for the output, with any pkey token masked. */
export function hostOf(url: string): string {
  try {
    return maskTokens(new URL(url).host);
  } catch {
    return maskTokens(url);
  }
}

/**
 * Fetch the product's discovery document and read the remote facts out of it. Nothing here
 * throws for a network failure or a refusal: each is a `todo` discovery fact, so the report goes on
 * to Signed in, Integration and the summary.
 */
export async function checkRemote(opts: {
  baseUrl: string;
  product: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RemoteDoctor> {
  const raw = `${opts.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(opts.product)}/.well-known/polaris.json`;
  const url = maskTokens(raw);
  const host = hostOf(raw);
  const down = (
    detail: string,
    code?: string,
    status?: number,
  ): RemoteDoctor => ({
    url,
    host,
    keys: [],
    keyStates: [],
    pinned: [],
    ...(status === undefined ? {} : { status }),
    services: [],
    signing: null,
    facts: [
      {
        id: "discovery",
        state: "todo",
        detail,
        ...(code ? { code } : {}),
      },
    ],
  });
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(
      raw,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  } catch (err) {
    if (opts.signal?.aborted)
      return down("The server did not answer in time.", "timeout");
    void err;
    return down(`Can't reach ${host}.`, "network");
  }
  if (!res.ok)
    return down(
      `Answered ${res.status} at ${host}`,
      "discovery-failed",
      res.status,
    );
  let body: unknown;
  try {
    body = await readCapped(res);
  } catch {
    return down(
      `${host} did not answer with discovery.`,
      "discovery-unreadable",
    );
  }
  const services = Object.entries(rec(rec(body)["services"]))
    .filter(([, service]) => rec(service)["enabled"] === true)
    .map(([slug]) => slug);
  // The real document keeps its keys under `trust`: `keys[]` with a status each, and the
  // `pinnedKeys` map (kid to public key) an app pins.
  const trust = rec(rec(body)["trust"]);
  const keyStates = asArray(trust["keys"])
    .map(rec)
    .filter((k) => typeof k["kid"] === "string" && k["kid"] !== "")
    .map((k) => ({
      kid: k["kid"] as string,
      status:
        typeof k["status"] === "string"
          ? (k["status"] as string)
          : k["active"] === true
            ? "active"
            : "unknown",
    }));
  const signing = rec(trust["pinnedKeys"]);
  const pinned = Object.keys(signing);
  const keys = keyStates.map((k) => k.kid);
  return {
    url,
    host,
    keys,
    keyStates,
    pinned,
    services,
    signing,
    facts: [
      { id: "discovery", state: "ok", detail: "answers" },
      {
        id: "services",
        state: services.length ? "ok" : "warn",
        detail: services.length ? services.join(", ") : "none enabled",
      },
      {
        id: "signing-keys",
        state: keys.length ? "ok" : "warn",
        detail: keys.length ? `${keys.length} exposed` : "none exposed",
      },
    ],
  };
}

// ── signed in and integration ────────────────────────────────────────────────────────────────

export interface SignedIn {
  /**
   * `in`: a person (or an API token) the console accepted. `out`: no credential. `ended`: the
   * credential was refused. `unreadable`: `/me` could not be read (a timeout, a server error).
   */
  state: "in" | "out" | "ended" | "unreadable";
  name?: string;
  email?: string;
  /** Epoch seconds; null when the token has no known end. */
  endsAt?: number | null;
  /** `personal` (`pkeyp_`) or `api` (`pkeya_`, no person behind it). */
  tokenType?: "personal" | "api";
  /** The warning's sentence and its one fix, for every state but `in`. */
  detail?: string;
  fix?: string;
  /** `network`, `redirect` or `not-a-console` when `/me` could not be read. */
  code?: string;
}

export type FeatureState = "verified" | "waiting" | "unseen";

export interface IntegrationFeatureFact {
  id: string;
  label: string;
  /** The feature overall: Verified anywhere, else Waiting for a first call, else after setup. */
  state: FeatureState;
  /** Per platform the product was seen on. */
  platforms: Record<string, FeatureState>;
}

export interface TodoStep {
  id: string;
  /** The console step in words ("A tier"). */
  label: string;
  /** The feature that needs it, in words ("Licensing"). */
  feature: string;
  /** The console page, on the base URL's origin. */
  link: string;
}

export interface IntegrationFacts {
  features: IntegrationFeatureFact[];
  /** Platforms an SDK was seen on, in name order: `{id, label}`. */
  platforms: Array<{ id: string; label: string }>;
  /** First release by CI, when the view says; null when it carries no such fact. */
  ci: { firstAt: number | null } | null;
  /** The release key ids the app pins, from the view's snippet. */
  releaseKeys: string[];
  /** Commerce is a feature when the product has it on. */
  commerce: "on" | "off";
  /** True while Licensing is off too, since Commerce needs it. */
  commerceNeedsLicensing: boolean;
  todo: TodoStep[];
}

export type IntegrationFact =
  | ({ state: "ok" } & IntegrationFacts)
  | { state: "skipped"; reason: "signed-out" | "no-product" | "ended" }
  | { state: "denied"; reason: string; access: AccessInfo | null }
  | { state: "unavailable"; detail: string; fix: string; code?: string };

export interface DoctorSession {
  signedIn: SignedIn;
  integration: IntegrationFact;
}

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  licensing: "Licensing",
  config: "Managed config",
  identity: "Sign-in",
  update: "Ship builds",
  packs: "Content packs",
  sync: "Cloud Sync",
  commerce: "Commerce",
};

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  macos: "macOS",
  ios: "iOS",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  web: "Web",
  godot: "Godot",
  server: "Server",
};

/** The console's words and page for each open step (`sections/core/model/integration.ts`). */
const STEPS: Readonly<Record<string, { label: string; page: string }>> = {
  tiers: { label: "A tier", page: "license/tiers" },
  catalog: { label: "A published catalog", page: "config/catalog" },
  oidc: { label: "A sign-in provider", page: "identity/app-sign-in" },
  release: { label: "A release", page: "release/releases" },
  distribution: { label: "Distribution turned on", page: "settings/features" },
  outlets: { label: "A channel", page: "distribution/outlets" },
  repository: { label: "A linked repository", page: "release/releases" },
};

/** What the output calls a step; `outlets` is the console's Channels page. */
const STEP_IDS: Readonly<Record<string, string>> = { outlets: "channels" };

const platformLabel = (id: string): string =>
  PLATFORM_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** A refusal's fix as a bare command: "Run pkey login once." is `pkey login`. */
export function bareFix(fix: string | undefined): string {
  const m = /^Run (pkey [^.]*?)(?: once| again)?\.?$/.exec(fix ?? "");
  return m?.[1] ?? fix ?? "pkey login";
}

/** The facts out of the Integration view; the view is the server's, so every field is checked. */
export function integrationFacts(
  view: unknown,
  slug: string,
  origin: string,
  env: UntrustedEnv,
): IntegrationFacts {
  const u = (v: unknown) => untrusted(v, env);
  const features = asArray(rec(view)["features"]).map(rec);
  const seen = new Set<string>();
  for (const f of features)
    for (const v of asArray(f["verifiedOn"])) {
      const p = rec(v)["platform"];
      if (typeof p === "string" && p) seen.add(p);
    }
  for (const s of asArray(rec(view)["sightings"])) {
    const p = rec(s)["platform"];
    if (typeof p === "string" && p) seen.add(p);
  }
  const platforms = [...seen]
    .map((id) => ({ id: u(id), label: u(platformLabel(id)) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const out: IntegrationFeatureFact[] = [];
  const todo: TodoStep[] = [];
  const have = new Set<string>();
  for (const f of features) {
    const id = String(f["id"] ?? "");
    have.add(id);
    const label = u(FEATURE_LABELS[id] ?? id);
    const status = f["status"];
    const verifiedOn = new Set(
      asArray(f["verifiedOn"]).map((v) => String(rec(v)["platform"])),
    );
    const base: FeatureState =
      status === "verified"
        ? "verified"
        : status === "not_seen"
          ? "waiting"
          : "unseen";
    const per: Record<string, FeatureState> = {};
    for (const p of platforms)
      per[p.id] = verifiedOn.has(p.id)
        ? "verified"
        : base === "waiting"
          ? "waiting"
          : "unseen";
    out.push({ id: u(id), label, state: base, platforms: per });
    if (f["unavailable"] === true) continue;
    for (const pre of asArray(f["prerequisites"]).map(rec)) {
      if (pre["met"] !== false) continue;
      const pid = String(pre["id"] ?? "");
      const step = STEPS[pid];
      const stepId = u(STEP_IDS[pid] ?? pid);
      const dup = todo.find((t) => t.id === stepId);
      if (dup) {
        if (!dup.feature.split(", ").includes(label))
          dup.feature += `, ${label}`;
        continue;
      }
      todo.push({
        id: stepId,
        label: u(step?.label ?? pid),
        feature: label,
        link: `${origin}/manage/#/p/${encodeURIComponent(slug)}/${step?.page ?? "settings/features"}`,
      });
    }
  }

  // CI's first release is Release's fact; the view carries it only when a feature reports it.
  let ci: IntegrationFacts["ci"] = null;
  for (const f of features) {
    const facts = rec(f["facts"]);
    if (typeof facts["packages"] === "number" && facts["packages"] > 0)
      ci = {
        firstAt:
          typeof facts["firstPackageAt"] === "number"
            ? facts["firstPackageAt"]
            : null,
      };
  }
  const releaseKeys = asArray(rec(rec(view)["snippet"])["releaseKeys"])
    .map((k) => rec(k)["kid"])
    .filter((k): k is string => typeof k === "string" && k !== "")
    .map(u);
  return {
    features: out,
    platforms,
    ci,
    releaseKeys,
    commerce: have.has("commerce") ? "on" : "off",
    commerceNeedsLicensing: !have.has("licensing"),
    todo,
  };
}

/** The open console steps in an Integration answer. */
export function todoCount(i: IntegrationFact): number {
  return i.state === "ok" ? i.todo.length : 0;
}

/**
 * Who is signed in, and what the Integration view says, over one deadline. Nothing here throws
 * for a refusal or a timeout: each is a state the report shows as a ▲ warning.
 */
export async function gatherSession(opts: {
  io: AdminIo;
  slug: string | null;
  signal?: AbortSignal;
}): Promise<DoctorSession> {
  const { io, slug, signal } = opts;
  const f = io.fetchImpl ?? fetch;
  const u = (v: unknown) => untrusted(v, io.env);
  let cred: ResolvedCredential;
  try {
    cred = await adminCredential({
      env: io.env,
      baseUrl: io.baseUrl,
      store: io.store,
    });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    const out = e.code === "not-signed-in";
    return {
      signedIn: {
        state: "out",
        detail: out ? "Integration needs it" : maskTokens(e.message),
        fix: bareFix(e.fix),
      },
      integration: { state: "skipped", reason: "signed-out" },
    };
  }
  const get = (path: string): Promise<Response> =>
    request(f, `${cred.origin}/manage/api${path}`, {
      redirect: "manual",
      ...(signal ? { signal } : {}),
      headers: {
        authorization: `Bearer ${cred.token}`,
        accept: "application/json",
      },
    });
  const api = cred.token.startsWith("pkeya_");
  const host = hostOf(cred.origin);
  /** What a failed read says: a redirect, an unreadable answer, or no answer at all. */
  const failed = (
    e: unknown,
  ): { detail: string; fix: string; code: string } => {
    if (signal?.aborted)
      return {
        detail: "The console did not answer in time.",
        fix: "pkey doctor",
        code: "timeout",
      };
    if (e instanceof Redirected)
      return {
        detail: maskTokens(e.message),
        fix: "Check --base-url.",
        code: "redirect",
      };
    if (e instanceof Unreachable || !(e instanceof ReadFailure))
      return {
        detail: `Can't reach ${host}.`,
        fix: "Check your network, or --base-url.",
        code: "network",
      };
    return {
      detail: `${host} didn't answer as a Polaris Key console.`,
      fix: "Check --base-url.",
      code: "not-a-console",
    };
  };
  const ended = (): DoctorSession => ({
    signedIn: {
      state: "ended",
      detail: `Your sign-in to ${host} has ended.`,
      fix: "pkey login",
    },
    integration: { state: "skipped", reason: "ended" },
  });

  let signedIn: SignedIn;
  if (api) {
    signedIn = {
      state: "in",
      tokenType: "api",
      endsAt: cred.expiresAt,
    };
  } else {
    try {
      const res = await get("/me");
      if (res.status === 401) return ended();
      if (!res.ok) {
        signedIn = {
          state: "unreadable",
          detail: `The console answered HTTP ${res.status} for your identity.`,
          fix: "pkey doctor",
        };
      } else {
        const me = rec(await readCapped(res));
        const ends =
          typeof me["sessionExpiresAt"] === "number"
            ? (me["sessionExpiresAt"] as number)
            : cred.expiresAt;
        signedIn = {
          state: "in",
          tokenType: "personal",
          name: u(me["name"] ?? ""),
          email: u(me["email"] ?? ""),
          endsAt: ends,
        };
      }
    } catch (e) {
      signedIn = { state: "unreadable", ...failed(e) };
    }
  }

  if (!slug)
    return {
      signedIn,
      integration: { state: "skipped", reason: "no-product" },
    };
  try {
    const res = await get(`/products/${encodeURIComponent(slug)}/integration`);
    if (res.status === 401) return ended();
    if (res.status === 403) {
      const failure = await httpError(res, "Integration");
      if (failure.detail.reason === "no_access")
        return {
          signedIn,
          integration: {
            state: "denied",
            reason: "no_access",
            access: await accessInfo(
              { ...io, ...(signal ? { signal } : {}) },
              cred,
              failure,
            ),
          },
        };
      return {
        signedIn,
        integration: {
          state: "denied",
          reason: api ? "api_token" : "personal_token",
          access: null,
        },
      };
    }
    if (!res.ok)
      return {
        signedIn,
        integration: {
          state: "unavailable",
          detail: `The console answered HTTP ${res.status}.`,
          fix: "pkey doctor",
        },
      };
    return {
      signedIn,
      integration: {
        state: "ok",
        ...integrationFacts(await readCapped(res), slug, cred.origin, io.env),
      },
    };
  } catch (e) {
    return {
      signedIn,
      integration: { state: "unavailable", ...failed(e) },
    };
  }
}

// ── the one report: facts → rows → text and JSON ─────────────────────────────────────────────

/** What a row's glyph says. `todo` is a ✗ and counts to the exit code; `warn` is a ▲. */
export type RowMark = "ok" | "warn" | "todo" | "wait" | "none";

/** One run of a row's detail: dim by default, `plain` for the value itself (a key id). */
export interface Part {
  text: string;
  role?: "plain" | "muted" | "accent" | "success";
  /** Joined to the part before with a space, so a name and its email stay together. */
  glue?: boolean;
}

export interface ReportRow {
  /** The glyph before the name (`  ✓ name`). */
  lead?: RowMark;
  name: string;
  /** The glyph and word after the name (a feature's state). */
  state?: { mark: RowMark; word: string };
  /** The detail, parts joined by the separator and never broken at it. */
  parts?: Part[];
  /** Extra lines under the row, each a list of parts. */
  notes?: Part[][];
  /** One fix, a bare command (or a short instruction). */
  fix?: string;
  /** More fixes, one line each (a command per app folder). */
  fixes?: string[];
  /** A console link, shown without its scheme and broken after `/` and `#`. */
  link?: string;
}

export interface ReportSection {
  title?: string;
  /** One line for the whole section: every row in it has this state (M10). */
  collapsed?: { mark: RowMark | null; word: string };
  rows: ReportRow[];
}

export interface DoctorReport {
  header: { name: string; slug: string | null; host: string };
  sections: ReportSection[];
  facts: DoctorFact[];
  /** Rows marked ✗ and rows marked ▲: the numbers on the summary line. */
  todo: number;
  warnings: number;
  /** 1 while anything is to do. The summary's colour and this follow the same count. */
  exit: 0 | 1;
}

/** The manifest, as the report needs it. */
export type ManifestInput =
  | { state: "missing"; problem: string }
  | {
      state: "read";
      result: ValidationResult;
      fileWarnings: string[];
    };

export interface ConfigFileCheck {
  /** The folders that hold a `polaris-key.json`, `./` for the current one. */
  dirs: string[];
  /** The hosts the files point at that are not the base URL's. */
  elsewhere: string[];
  /** Pins in a file that discovery does not expose; null when discovery did not say. */
  stalePins: string[] | null;
}

export interface ReportInput {
  product: { slug: string; name?: string } | null;
  baseUrl: string;
  manifest: ManifestInput;
  /** Null when no product is known, so there is nothing to ask. */
  remote: RemoteDoctor | null;
  session: DoctorSession;
  config: ConfigFileCheck;
  env: UntrustedEnv;
}

const STATE_WORD: Readonly<Record<FeatureState, string>> = {
  verified: "Verified",
  waiting: "Waiting",
  unseen: "Not seen yet",
};
const STATE_MARK: Readonly<Record<FeatureState, RowMark>> = {
  verified: "ok",
  waiting: "wait",
  unseen: "none",
};
const featureState = (st: FeatureState): { mark: RowMark; word: string } => ({
  mark: STATE_MARK[st],
  word: STATE_WORD[st],
});

const dim = (text: string): Part => ({ text });
const plain = (text: string): Part => ({ text, role: "plain" });

/** The report, from the same facts that set the exit code: one list, text and JSON alike. */
export function buildReport(input: ReportInput): DoctorReport {
  const { session: s, remote, config } = input;
  const u = (v: unknown) => untrusted(v, input.env);
  const facts: DoctorFact[] = [];
  const sections: ReportSection[] = [];
  const hostName = hostOf(input.baseUrl);

  // Manifest: the `.pkey/` verdict, what the server enables, who is signed in, the config file.
  const manifest: ReportRow[] = [];
  const m = input.manifest;
  if (m.state === "missing") {
    facts.push(manifestFact(null, m.problem));
    manifest.push({
      lead: "todo",
      name: ".pkey/",
      parts: [
        dim(/^No \.pkey\//.test(m.problem) ? "Not found here" : u(m.problem)),
      ],
      fix: /^No \.pkey\//.test(m.problem) ? "pkey init" : "pkey validate",
    });
  } else {
    facts.push(manifestFact(m.result, undefined, m.fileWarnings));
    const r = m.result;
    if (r.ok)
      manifest.push({
        lead: "ok",
        name: ".pkey/",
        parts: [
          dim("valid"),
          ...(r.enabledModules.length
            ? [dim(r.enabledModules.join(", "))]
            : []),
        ],
      });
    for (const w of m.fileWarnings)
      manifest.push({
        lead: "warn",
        name: ".pkey/",
        parts: [dim(u(w))],
      });
    for (const w of r.warnings)
      manifest.push({
        lead: "warn",
        name: u(`${w.file}${w.path}`),
        parts: [dim(u(w.message))],
        ...(w.code === "deprecated_spelling" ? { fix: VALIDATE_FIX } : {}),
      });
    for (const e of r.errors)
      manifest.push({
        lead: "todo",
        name: u(`${e.file}${e.path}`),
        parts: [dim(u(e.message))],
        fix: "pkey validate",
      });
  }

  const signed = s.signedIn;
  if (signed.state === "in") {
    const person: Part[] =
      signed.tokenType === "api"
        ? [dim("API token, no person")]
        : signed.name && signed.email
          ? [dim(signed.name), { text: `(${signed.email})`, glue: true }]
          : [dim(signed.name || signed.email || "yes")];
    manifest.push({
      lead: "ok",
      name: "Signed in",
      parts: [
        ...person,
        ...(signed.endsAt
          ? [dim(`ends ${day(signed.endsAt, input.env)}`)]
          : []),
      ],
    });
  } else
    manifest.push({
      lead: "warn",
      name:
        signed.state === "out" && signed.detail === "Integration needs it"
          ? "Not signed in"
          : "Signed in",
      parts: [dim(u(signed.detail ?? "Not signed in"))],
      ...(signed.fix ? { fix: signed.fix } : {}),
    });

  if (config.dirs.length) {
    const bad = config.elsewhere.length || config.stalePins?.length;
    facts.push({
      id: "config-file",
      state: bad ? "warn" : "ok",
      detail: bad ? "does not match the base URL" : "matches",
    });
    manifest.push({
      lead: bad ? "warn" : "ok",
      name: "polaris-key.json",
      parts: [
        dim(config.dirs.join(" and ")),
        dim(
          config.elsewhere.length
            ? `points at ${config.elsewhere.map(u).join(", ")}, not ${hostName}`
            : config.stalePins?.length
              ? `pins ${config.stalePins.map(u).join(", ")} are not exposed by ${hostName}`
              : config.stalePins
                ? `pins match ${hostName}`
                : `points at ${hostName}`,
        ),
      ],
      ...(bad ? { fix: "pkey help sdk" } : {}),
    });
  } else
    manifest.push({
      lead: "none",
      name: "polaris-key.json",
      parts: [dim("Not found here")],
    });

  // Discovery.
  const keys: ReportRow[] = [];
  if (remote) {
    facts.push(...remote.facts);
    const d = remote.facts[0]!;
    if (d.state === "todo") {
      keys.push({
        lead: "todo",
        name: "Discovery",
        parts: [dim(d.detail)],
        fix:
          d.code === "network" || d.code === "timeout"
            ? "Check your network, or --base-url."
            : "Check --base-url, or register the product in the console.",
      });
    } else {
      const svc = remote.facts.find((f) => f.id === "services")!;
      if (m.state === "read" && m.result.ok) {
        const sync = syncFact(m.result.enabledModules, remote.services);
        facts.push(sync);
        manifest.splice(1, 0, {
          lead: sync.state === "ok" ? "ok" : "warn",
          name: "In sync",
          parts: [dim(sync.state === "ok" ? "Features match" : u(sync.detail))],
          ...(sync.fix ? { fix: sync.fix } : {}),
        });
      }
      manifest.splice(1, 0, {
        lead: svc.state === "ok" ? "ok" : "warn",
        name: "Services",
        parts: [
          dim(
            remote.services.length
              ? remote.services.map(u).join(", ")
              : "none enabled",
          ),
        ],
      });
      if (!remote.keyStates.length)
        keys.push({
          lead: "warn",
          name: "Signing key",
          parts: [dim("none exposed")],
        });
      for (const k of remote.keyStates) {
        if (k.status === "staged") {
          // Not a problem: the app's config file pins it before it becomes active.
          const folders = config.dirs.length ? config.dirs : ["./"];
          keys.push({
            lead: "warn",
            name: "Next signing key",
            parts: [plain(u(k.kid)), dim("is staged")],
            fixes: folders.map((d) =>
              `pkey sdk --lang <sdk> --write --out ${d === "./" ? "" : d}`.trimEnd(),
            ),
            notes: [
              [dim(`Pin ${u(k.kid)} beside the active key in each folder.`)],
            ],
          });
        } else
          keys.push({
            lead: k.status === "active" ? "ok" : "none",
            name: "Signing key",
            parts: [plain(u(k.kid)), dim(u(k.status))],
          });
      }
    }
  } else
    manifest.push({
      lead: "none",
      name: "Discovery",
      parts: [dim("Needs a product: pass --product")],
    });
  if (s.integration.state === "ok")
    for (const kid of s.integration.releaseKeys)
      keys.push({
        lead: "ok",
        name: "Release key",
        parts: [plain(kid), dim("pinned")],
      });

  sections.push({ title: "Manifest", rows: manifest });
  if (keys.length) sections.push({ title: "Keys", rows: keys });

  // Integration.
  const i = s.integration;
  if (i.state === "denied") {
    if (i.access) {
      const a = i.access;
      const notes: Part[][] = [
        [
          dim(
            a.roles.length
              ? `Your roles: ${a.roles.map(u).join(", ")}.`
              : "You have no role here.",
          ),
        ],
        [
          dim(
            a.people.length
              ? "Ask one of these people:"
              : "Ask an admin to give you access.",
          ),
        ],
        ...a.people.map((p) => [
          dim(u(p.name)),
          { text: u(p.email), glue: true },
          dim(u(p.role)),
        ]),
      ];
      sections.push({
        rows: [
          {
            lead: "warn",
            name: "Integration",
            parts: [
              dim(`You don't have access to ${u(a.product)} (${u(a.area)}).`),
            ],
            notes,
          },
        ],
      });
    } else
      sections.push({
        rows: [
          {
            lead: "warn",
            name: "Integration",
            parts: [
              dim(
                `Isn't available to ${i.reason === "api_token" ? "API" : "personal"} tokens.`,
              ),
            ],
            fix: "pkey login",
          },
        ],
      });
  } else if (i.state === "unavailable") {
    sections.push({
      rows: [
        {
          lead: "warn",
          name: "Integration",
          parts: [dim(i.detail)],
          fix: i.fix,
        },
      ],
    });
  } else if (i.state === "skipped" && i.reason === "no-product") {
    manifest.push({
      lead: "none",
      name: "Integration",
      parts: [dim("Needs a product: pass --product")],
    });
  } else if (i.state === "ok") {
    const block = (
      title: string,
      pick: (f: IntegrationFeatureFact) => FeatureState,
    ): ReportSection => {
      const states = i.features.map(pick);
      return states.length && states.every((x) => x === states[0])
        ? { title, collapsed: featureState(states[0]!), rows: [] }
        : {
            title,
            rows: i.features.map((f) => ({
              name: f.label,
              state: featureState(pick(f)),
            })),
          };
    };
    if (i.features.length) {
      if (!i.platforms.length)
        sections.push(block("Integration", (f) => f.state));
      for (const p of i.platforms)
        sections.push(
          block(
            `Integration on ${p.label}`,
            (f) => f.platforms[p.id] ?? "unseen",
          ),
        );
    }
    if (i.ci)
      sections.push({
        title: "CI",
        rows: [
          {
            lead: "ok",
            name: "First release",
            parts: i.ci.firstAt ? [dim(day(i.ci.firstAt, input.env))] : [],
          },
        ],
      });
    sections.push({
      title: "Commerce",
      collapsed:
        i.commerce === "on"
          ? { mark: "ok", word: "on" }
          : {
              mark: null,
              word: i.commerceNeedsLicensing ? "off, needs Licensing" : "off",
            },
      rows: [],
    });
    if (i.todo.length)
      sections.push({
        title: "Left to do",
        rows: i.todo.map((step) => ({
          lead: "todo",
          name: step.label,
          parts: [dim(`${step.feature} needs it`)],
          link: step.link,
        })),
      });
  }

  let todo = 0;
  let warnings = 0;
  for (const sec of sections)
    for (const row of sec.rows) {
      if (row.lead === "todo") todo++;
      if (row.lead === "warn") warnings++;
    }
  return {
    header: {
      name: input.product?.name ?? input.product?.slug ?? "Polaris Key",
      slug: input.product?.name ? input.product.slug : null,
      host: hostName,
    },
    sections,
    facts,
    todo,
    warnings,
    exit: todo ? 1 : 0,
  };
}

/** The `signedIn` and `integration` members of `pkey doctor --json`. */
export function sessionJson(s: DoctorSession): {
  signedIn: Record<string, unknown>;
  integration: Record<string, unknown>;
} {
  const iso = (seconds: number | null | undefined): string | null =>
    typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
  const { endsAt, ...rest } = s.signedIn;
  const i = s.integration;
  return {
    signedIn: {
      ...rest,
      ...(endsAt === undefined ? {} : { endsAt: iso(endsAt) }),
    },
    integration:
      i.state === "ok"
        ? { ...i, ci: i.ci ? { firstAt: iso(i.ci.firstAt) } : null }
        : { ...i },
  };
}

// ── drawing it ───────────────────────────────────────────────────────────────────────────────

/** Below this the state goes under the feature name (M7). */
const STACK_BELOW = 36;
/** At this width the value column is fixed, as in the mockup. */
const WIDE = 60;
const VALUE_COL = 30;
const NAME_CAP = 24;

/** `text` broken after `/` or `#` into lines of at most `width` columns, never shortened. */
function breakLink(text: string, width: number): string[] {
  const parts = text.match(/[^/#]*[/#]?/g)?.filter(Boolean) ?? [text];
  const lines: string[] = [];
  let cur = "";
  for (let part of parts) {
    while (cellWidth(part) > width) {
      const room = width - cellWidth(cur);
      if (room > 0 && cur) {
        lines.push(cur + part.slice(0, room));
        part = part.slice(room);
        cur = "";
      } else {
        lines.push(part.slice(0, width));
        part = part.slice(width);
      }
    }
    if (cellWidth(cur) + cellWidth(part) > width && cur) {
      lines.push(cur);
      cur = "";
    }
    cur += part;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Pieces that join the one before with a space, not the separator (a name and its email). */
const glued = new WeakSet<Line>();

const lineWidth = (l: Line): number =>
  l.reduce((n, sp) => n + cellWidth(sp.text), 0);

/**
 * Pieces joined by the separator on as few lines as `width` allows: a piece that does not fit
 * starts a line of its own, so the separator never starts or ends one (m15).
 */
function flow(pieces: Line[], width: number, sep: string): Line[] {
  const bar: Line = [{ text: ` ${sep} `, style: ["muted"] }];
  const space: Line = [{ text: " " }];
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const piece of pieces) {
    const wrapped = wrapSpans(piece, Math.max(1, width));
    if (!wrapped.length) continue;
    const joint = glued.has(piece) ? space : bar;
    const jw = lineWidth(joint);
    if (
      cur &&
      wrapped.length === 1 &&
      lineWidth(cur) + jw + lineWidth(wrapped[0]!) <= width
    ) {
      cur = [...cur, ...joint, ...wrapped[0]!];
      continue;
    }
    if (cur) lines.push(cur);
    lines.push(...wrapped.slice(0, -1));
    cur = wrapped[wrapped.length - 1]!;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** The report as lines: one wrapping row renderer for every line (DL6-DL8, DL12). */
export function renderReport(
  report: DoctorReport,
  t: Term,
  runMs: number,
): string {
  const { painter, symbols, caps } = t;
  const cyan = new Painter(caps, null, {}, false);
  const width = Math.max(20, caps.columns);
  const wide = width >= WIDE;
  const stackAll = width < STACK_BELOW;
  const sep = symbols.separator;
  const arrow = caps.unicode ? "→" : "->";
  const out: string[] = [];
  const glyph = (mark: RowMark): string =>
    mark === "ok"
      ? painter.style(symbols.ok, ["success"])
      : mark === "warn"
        ? painter.style(symbols.warn, ["warning"])
        : mark === "todo"
          ? painter.style(symbols.fail, ["danger"])
          : mark === "wait"
            ? cyan.style(symbols.radioOn, ["accent"])
            : painter.style(symbols.radioOff, ["muted"]);
  /** A leading glyph's cell: one column, or the three of the ASCII radio "( )". */
  const glyphCells = caps.unicode ? 1 : 3;
  const glyphWidth = (mark: RowMark): number =>
    cellWidth(
      mark === "ok"
        ? symbols.ok
        : mark === "warn"
          ? symbols.warn
          : mark === "todo"
            ? symbols.fail
            : mark === "wait"
              ? symbols.radioOn
              : symbols.radioOff,
    );
  const piece = (p: Part): Line => {
    const line: Line = [
      {
        text: p.text,
        ...(p.role === "plain" ? {} : { style: [p.role ?? "muted"] }),
      },
    ];
    if (p.glue) glued.add(line);
    return line;
  };
  const stateText = (st: { mark: RowMark | null; word: string }): string =>
    st.mark === null
      ? painter.style(st.word, ["muted"])
      : `${glyph(st.mark)} ${
          st.mark === "wait"
            ? cyan.style(st.word, ["accent"])
            : st.mark === "ok"
              ? painter.style(st.word, ["success"])
              : st.mark === "none"
                ? painter.style(st.word, ["muted"])
                : st.word
        }`;
  const heading = (v: string) => painter.style(v, ["strong"]);
  const paint = (l: Line) => painter.line(l);

  /** The state's width in cells: the glyph (as the symbol set draws it), a space, the word. */
  const stateWidth = (st: { mark: RowMark | null; word: string }) =>
    st.mark === null
      ? cellWidth(st.word)
      : cellWidth(
          st.mark === "ok"
            ? symbols.ok
            : st.mark === "warn"
              ? symbols.warn
              : st.mark === "todo"
                ? symbols.fail
                : st.mark === "wait"
                  ? symbols.radioOn
                  : symbols.radioOff,
        ) +
        1 +
        cellWidth(st.word);

  /** Heading, then its state on the same line when it fits, else under it. */
  const collapsed = (
    title: string,
    st: { mark: RowMark | null; word: string },
  ) => {
    const col = wide ? VALUE_COL : cellWidth(title) + 2;
    if (!stackAll && col + stateWidth(st) <= width)
      out.push(
        `${heading(title)}${" ".repeat(Math.max(2, col - cellWidth(title)))}${stateText(st)}`,
      );
    else {
      out.push(heading(title));
      out.push(`  ${stateText(st)}`);
    }
  };

  const row = (r: ReportRow, nameW: number) => {
    const ns = r.lead ? 3 + glyphCells : 2;
    const prefix = `  ${r.lead ? `${glyph(r.lead)}${" ".repeat(glyphCells + 1 - glyphWidth(r.lead))}` : ""}`;
    const valuePieces: Line[] = (r.parts ?? []).map(piece);
    const stateWords = r.state ? stateText(r.state) : null;
    const valueCol = wide ? VALUE_COL : ns + nameW + 2;
    const avail = width - valueCol;
    // The value as lines (the state's glyph and word are one unbreakable piece in front).
    const valueLines = (w: number): string[] => {
      const lines = flow(
        valuePieces,
        w - (r.state ? stateWidth(r.state) + 1 : 0),
        sep,
      ).map(paint);
      if (!r.state) return lines;
      const lead = stateWords!;
      if (!lines.length) return [lead];
      const [first, ...rest] = lines;
      return [`${lead} ${first}`, ...rest];
    };
    const hasValue = valuePieces.length > 0 || r.state;
    let used = false;
    if (
      hasValue &&
      !(stackAll && r.state) &&
      cellWidth(r.name) <= (wide ? VALUE_COL - ns - 2 : nameW) &&
      avail >= 12
    ) {
      const lines = valueLines(avail);
      if (wide || lines.length === 1) {
        const pad = " ".repeat(Math.max(2, valueCol - ns - cellWidth(r.name)));
        lines.forEach((l, n) =>
          out.push(
            n === 0
              ? `${prefix}${r.name}${pad}${l}`
              : `${" ".repeat(valueCol)}${l}`,
          ),
        );
        used = true;
      }
    }
    if (!used) {
      const nameLines = wrapSpans([{ text: r.name }], Math.max(1, width - ns));
      nameLines.forEach((l, n) =>
        out.push(
          n === 0 ? `${prefix}${paint(l)}` : `${" ".repeat(ns)}${paint(l)}`,
        ),
      );
      if (hasValue) for (const l of valueLines(width - 4)) out.push(`    ${l}`);
    }
    for (const note of r.notes ?? [])
      for (const l of flow(note.map(piece), width - 4, sep))
        out.push(`    ${paint(l)}`);
    const fixIndent = stackAll ? 4 : 6;
    for (const fixText of [...(r.fix ? [r.fix] : []), ...(r.fixes ?? [])])
      wrapSpans(
        [{ text: fixText }],
        Math.max(1, width - fixIndent - 2),
      ).forEach((l, n) =>
        out.push(
          `${" ".repeat(fixIndent)}${n === 0 ? `${arrow} ` : "  "}${paint(l)}`,
        ),
      );
    if (r.link) {
      const link = r.link.replace(/^https?:\/\//, "");
      breakLink(link, width - fixIndent - 2).forEach((l, n) =>
        out.push(
          `${" ".repeat(fixIndent)}${n === 0 ? `${arrow} ` : "  "}${painter.style(l, ["muted"])}`,
        ),
      );
    }
  };

  // Header: the product, its slug and the host.
  const h = report.header;
  const headPieces: Line[] = [
    [
      { text: h.name, style: ["strong"] },
      ...(h.slug ? [{ text: ` (${h.slug})`, style: ["muted"] }] : []),
    ],
    [{ text: h.host, style: ["muted"] }],
  ];
  for (const l of flow(headPieces, width, sep)) out.push(paint(l));

  for (const sec of report.sections) {
    out.push("");
    if (sec.collapsed && sec.title) {
      collapsed(sec.title, sec.collapsed);
      continue;
    }
    if (sec.title) out.push(heading(sec.title));
    // A name too long for the column stacks its value; it does not widen the column for the rest.
    const room = Math.min(NAME_CAP, width - 4 - 2 - 14);
    const nameW = Math.max(
      8,
      ...sec.rows.map((r) => cellWidth(r.name)).filter((w) => w <= room),
    );
    for (const r of sec.rows) row(r, nameW);
  }

  // Summary: the counts the exit code follows, then how long the run took.
  out.push("");
  const summary: Line[] = [
    [
      {
        text: `${report.todo} to do`,
        style: [report.todo ? "danger" : "success"],
      },
    ],
    [
      {
        text: plural(report.warnings, "warning"),
        style: [report.warnings ? "warning" : "muted"],
      },
    ],
    [{ text: `${(runMs / 1000).toFixed(1)} s`, style: ["muted"] }],
  ];
  for (const l of flow(summary, width, sep)) out.push(paint(l));
  return `${out.join("\n")}\n`;
}

/** The report's header facts for the `--json` line. */
export function reportJson(report: DoctorReport): {
  facts: DoctorFact[];
  summary: { todo: number; warnings: number };
} {
  return {
    facts: report.facts,
    summary: { todo: report.todo, warnings: report.warnings },
  };
}

/** Where the SDK config files are, and whether they match the base URL and the exposed keys. */
export async function checkConfigFiles(opts: {
  cwd: string;
  host: string;
  exposed: string[] | null;
}): Promise<ConfigFileCheck> {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const found: Array<{ dir: string; file: unknown }> = [];
  const tryRead = async (dir: string, label: string) => {
    try {
      const text = await readFile(path.join(dir, "polaris-key.json"), "utf8");
      found.push({ dir: label, file: JSON.parse(text) as unknown });
    } catch {
      // no file here, or not JSON
    }
  };
  await tryRead(opts.cwd, "./");
  try {
    const entries = await readdir(opts.cwd, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        e.name !== "node_modules"
      )
        await tryRead(path.join(opts.cwd, e.name), `${e.name}/`);
  } catch {
    // an unreadable folder has nothing to report
  }
  const elsewhere: string[] = [];
  const pinned = new Set<string>();
  for (const { file } of found) {
    const base = rec(file)["baseUrl"];
    if (typeof base === "string") {
      const host = hostOf(base);
      if (host !== opts.host && !elsewhere.includes(host)) elsewhere.push(host);
    }
    for (const k of Object.keys(rec(rec(rec(file)["trust"])["pinnedKeys"])))
      pinned.add(k);
  }
  return {
    dirs: found.map((f) => f.dir),
    elsewhere,
    stalePins: opts.exposed
      ? [...pinned].filter((k) => !opts.exposed!.includes(k))
      : null,
  };
}
