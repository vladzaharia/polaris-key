/**
 * `pkey doctor`'s facts (P0-45): what the CLI can verify about this product, as data, so the
 * text and `--json` answers cannot differ. The facts are the CLI's twin of the console's
 * Integration verdict for the parts both can see without an SDK having called in:
 *
 *   manifest      `.pkey/` validates (a warning is a ▲, an error a ✗ to do)
 *   discovery     `<base-url>/<product>/.well-known/polaris.json` answers
 *   services      the services discovery says are enabled
 *   signing-keys  the signing keys discovery exposes
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

import { cellWidth, wrapSpans } from "@polaris-key/node/terminal";
import { day, glyphOf } from "./account.js";
import {
  accessInfo,
  accessText,
  type AccessInfo,
  type AdminIo,
} from "./adminAuth.js";
import { httpError, request } from "./bundle.js";
import {
  adminCredential,
  Refusal,
  type ResolvedCredential,
} from "./credentials.js";
import { networkMessage } from "./errors.js";
import type { ValidationResult } from "./manifest.js";
import type { Term } from "./terminal.js";
import { untrusted, type UntrustedEnv } from "./untrusted.js";

/** One deadline for every request a doctor run makes. */
export const DOCTOR_TIMEOUT_MS = 15_000;

export type DoctorState = "ok" | "warn" | "todo";

export interface DoctorFact {
  id: "manifest" | "discovery" | "services" | "signing-keys";
  state: DoctorState;
  /** One plain sentence; for a remote fact it quotes the server, so it is cleaned on output. */
  detail: string;
}

export interface RemoteDoctor {
  url: string;
  /** The HTTP status when the server answered with a refusal. */
  status?: number;
  services: string[];
  signing: unknown;
  facts: DoctorFact[];
}

/** The manifest fact from a validation, or from the reason no manifest could be read. */
export function manifestFact(
  result: ValidationResult | null,
  problem?: string,
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
      detail: `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`,
    };
  return {
    id: "manifest",
    state: result.warnings.length ? "warn" : "ok",
    detail: result.warnings.length
      ? `${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`
      : "valid",
  };
}

/** Fetch the product's discovery document and read the remote facts out of it. */
export async function checkRemote(opts: {
  baseUrl: string;
  product: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<RemoteDoctor> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(opts.product)}/.well-known/polaris.json`;
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(
      url,
      opts.signal ? { signal: opts.signal } : undefined,
    );
  } catch (err) {
    throw new Error(networkMessage(err, url));
  }
  if (!res.ok)
    return {
      url,
      status: res.status,
      services: [],
      signing: null,
      facts: [
        {
          id: "discovery",
          state: "todo",
          detail: `failed (${res.status})`,
        },
      ],
    };
  const body = (await res.json()) as {
    signing?: unknown;
    trust?: unknown;
    services?: Record<string, { enabled?: unknown } | undefined>;
  };
  const services = Object.entries(body.services ?? {})
    .filter(([, service]) => service?.enabled === true)
    .map(([slug]) => slug);
  const signing = body.signing ?? body.trust ?? {};
  const keys =
    signing !== null && typeof signing === "object"
      ? Object.keys(signing).length
      : 0;
  return {
    url,
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
        state: keys ? "ok" : "warn",
        detail: keys ? `${keys} exposed` : "none exposed",
      },
    ],
  };
}

/** `ok` unless a fact is still to do; the process exits 1 when this is false. */
export function doctorOk(facts: readonly DoctorFact[]): boolean {
  return facts.every((f) => f.state !== "todo");
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
  | { state: "unavailable"; detail: string };

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
  return {
    features: out,
    platforms,
    ci,
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
    const out = e.message.startsWith("Not signed in");
    return {
      signedIn: {
        state: "out",
        detail: out ? "Not signed in" : e.message,
        fix: out ? "pkey login" : (e.fix ?? "pkey login"),
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
  const reach = (): string =>
    signal?.aborted
      ? "The console did not answer in time."
      : `Could not reach ${new URL(cred.origin).host}.`;

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
      if (res.status === 401)
        return {
          signedIn: {
            state: "ended",
            detail: "Your sign-in has ended",
            fix: "pkey login",
          },
          integration: { state: "skipped", reason: "ended" },
        };
      if (!res.ok) {
        signedIn = {
          state: "unreadable",
          detail: `Could not read your identity (HTTP ${res.status})`,
        };
      } else {
        const me = rec(await res.json());
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
    } catch {
      signedIn = { state: "unreadable", detail: reach() };
    }
  }

  if (!slug)
    return {
      signedIn,
      integration: { state: "skipped", reason: "no-product" },
    };
  try {
    const res = await get(`/products/${encodeURIComponent(slug)}/integration`);
    if (res.status === 401)
      return {
        signedIn: {
          state: "ended",
          detail: "Your sign-in has ended",
          fix: "pkey login",
        },
        integration: { state: "skipped", reason: "ended" },
      };
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
        },
      };
    return {
      signedIn,
      integration: {
        state: "ok",
        ...integrationFacts(await res.json(), slug, cred.origin, io.env),
      },
    };
  } catch {
    return {
      signedIn,
      integration: { state: "unavailable", detail: reach() },
    };
  }
}

// ── the same facts, as text and as JSON ──────────────────────────────────────────────────────

/** Warnings the session adds to the summary: a ▲ row each. */
export function sessionWarnings(s: DoctorSession): number {
  return (
    (s.signedIn.state === "in" ? 0 : 1) +
    (s.integration.state === "denied" || s.integration.state === "unavailable"
      ? 1
      : 0)
  );
}

const iso = (seconds: number | null | undefined): string | null =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;

/** The `signedIn` and `integration` members of `pkey doctor --json`. */
export function sessionJson(s: DoctorSession): {
  signedIn: Record<string, unknown>;
  integration: Record<string, unknown>;
} {
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

const WIDE = 60;
const NAME_W = 24;

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

/** The report's text, drawn from the session's facts (DL6-DL8; 80 columns, re-wrapped narrow). */
export function sessionText(
  s: DoctorSession,
  t: Term,
  env: UntrustedEnv = {},
): string {
  const { painter, symbols, caps } = t;
  const width = Math.max(20, caps.columns);
  const wide = width >= WIDE;
  const out: string[] = [];
  const mark = {
    ok: glyphOf(t, "ok"),
    warn: glyphOf(t, "warn"),
    fail: glyphOf(t, "fail"),
    wait: painter.style(symbols.radioOn, ["strong"]),
    none: painter.style(symbols.radioOff, ["muted"]),
  };
  const text = (v: string, roles: string[] = []) =>
    roles.length ? painter.style(v, roles) : v;
  const heading = (v: string) => out.push(painter.style(v, ["strong"]));
  const wrapAt = (v: string, indent: number): string[] =>
    wrapSpans([{ text: v }], Math.max(1, width - indent)).map((l) =>
      painter.line(l),
    );
  /** `  ✓ name   value`, the value wrapped under itself. */
  const row = (m: string, name: string, value: string, nameW = NAME_W) => {
    if (wide) {
      const indent = 4 + nameW + 2;
      wrapAt(value, indent).forEach((l, i) =>
        out.push(
          i === 0
            ? `  ${m} ${painter.style(name.padEnd(nameW), ["strong"])}  ${l}`
            : `${" ".repeat(indent)}${l}`,
        ),
      );
      return;
    }
    if (4 + cellWidth(name) + 2 + cellWidth(value) <= width)
      out.push(`  ${m} ${painter.style(name, ["strong"])}  ${value}`);
    else {
      out.push(`  ${m} ${painter.style(name, ["strong"])}`);
      for (const l of wrapAt(value, 4)) out.push(`    ${l}`);
    }
  };
  const fix = (v: string) => {
    for (const [i, l] of wrapAt(v, wide ? 8 : 6).entries())
      out.push(`${" ".repeat(wide ? 6 : 4)}${i === 0 ? "→ " : "  "}${l}`);
  };
  const stateWord = (st: FeatureState) =>
    st === "verified"
      ? `${mark.ok} Verified`
      : st === "waiting"
        ? `${mark.wait} Waiting`
        : `${mark.none} Not seen yet`;
  const stateMark = (st: FeatureState) =>
    st === "verified" ? mark.ok : st === "waiting" ? mark.wait : mark.none;
  const stateText = (st: FeatureState) =>
    st === "verified"
      ? "Verified"
      : st === "waiting"
        ? "Waiting"
        : "Not seen yet";
  const blank = () => out.push("");

  // Signed in.
  const si = s.signedIn;
  if (si.state === "in") {
    const who =
      si.tokenType === "api"
        ? "API token, no person"
        : [
            si.name && si.email
              ? `${si.name} (${si.email})`
              : si.name || si.email,
            si.endsAt ? `ends ${day(si.endsAt, env)}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
    row(mark.ok, "Signed in", who || "yes");
  } else {
    row(mark.warn, "Signed in", si.detail ?? "Not signed in");
    if (si.fix) fix(si.fix);
  }

  // Integration.
  const i = s.integration;
  if (i.state === "denied") {
    blank();
    if (i.access) out.push(accessText(i.access, t).trimEnd());
    else
      row(
        mark.warn,
        "Integration",
        `Isn't available to ${i.reason === "api_token" ? "API" : "personal"} tokens.`,
      );
  } else if (i.state === "unavailable") {
    blank();
    row(mark.warn, "Integration", i.detail);
  } else if (i.state === "ok") {
    /** A platform where nothing is verified: one line, at heading level. */
    const collapsed = (label: string, st: FeatureState) => {
      if (wide)
        out.push(
          `${painter.style(label.padEnd(NAME_W + 6), ["strong"])}${stateWord(st)}`,
        );
      else {
        heading(label);
        out.push(`  ${stateWord(st)}`);
      }
    };
    const featureRows = (pick: (f: IntegrationFeatureFact) => FeatureState) => {
      const nameW = Math.max(
        NAME_W - 2,
        ...i.features.map((f) => cellWidth(f.label)),
      );
      for (const f of i.features) {
        if (wide) {
          out.push(
            `  ${painter.style(f.label.padEnd(NAME_W + 2), ["strong"])}  ${stateWord(pick(f))}`,
          );
        } else {
          const w = Math.min(nameW, 16);
          const st = pick(f);
          out.push(
            `  ${stateMark(st)} ${painter.style(f.label.padEnd(w), ["strong"])} ${stateText(st)}`,
          );
        }
      }
    };
    if (i.features.length) {
      if (!i.platforms.length) {
        blank();
        heading("Integration");
        featureRows((f) => f.state);
      }
      for (const p of i.platforms) {
        blank();
        const mine = i.features.map((f) => f.platforms[p.id] ?? "unseen");
        if (!mine.includes("verified")) {
          const st: FeatureState = mine.includes("waiting")
            ? "waiting"
            : "unseen";
          collapsed(`Integration on ${p.label}`, st);
          continue;
        }
        heading(`Integration on ${p.label}`);
        featureRows((f) => f.platforms[p.id] ?? "unseen");
      }
    }
    if (i.ci) {
      blank();
      heading("CI");
      out.push(
        `  ${mark.ok} First release${i.ci.firstAt ? `, ${day(i.ci.firstAt, env)}` : ""}`,
      );
    }
    if (i.commerce === "off") {
      blank();
      const note = i.commerceNeedsLicensing ? "off, needs Licensing" : "off";
      out.push(
        wide
          ? `${painter.style("Commerce".padEnd(NAME_W + 6), ["strong"])}${text(note, ["muted"])}`
          : `${painter.style("Commerce", ["strong"])}  ${text(note, ["muted"])}`,
      );
    }
    if (i.todo.length) {
      blank();
      heading("Left to do");
      for (const step of i.todo) {
        row(mark.fail, step.label, `${step.feature} needs it`);
        const link = step.link.replace(/^https?:\/\//, "");
        for (const [n, l] of breakLink(link, width - (wide ? 8 : 6)).entries())
          out.push(
            `${" ".repeat(wide ? 6 : 4)}${n === 0 ? "→ " : "  "}${text(l, ["muted"])}`,
          );
      }
    }
  }

  // Summary.
  const todo = todoCount(i);
  const warnings = sessionWarnings(s);
  blank();
  out.push(
    painter.style(
      `${todo} to do · ${warnings} warning${warnings === 1 ? "" : "s"}`,
      [todo ? "danger" : warnings ? "warning" : "success"],
    ),
  );
  return `${out.join("\n")}\n`;
}
