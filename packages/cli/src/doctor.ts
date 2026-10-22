/**
 * `pkey doctor`'s facts (P0-45): what the CLI can verify about this product, as data, gathered
 * once. The text answer renders these same facts (`index.ts`), so it and `--json` cannot differ.
 * The facts are the CLI's twin of the console's Integration verdict for the parts both can see
 * without an SDK having called in:
 *
 *   manifest      `.pkey/` validates (a warning is a ▲, an error a ✗ to do)
 *   discovery     `<base-url>/<product>/.well-known/polaris.json` answers
 *   services      the features discovery says are enabled
 *   signing-keys  the signing keys discovery exposes (one per key)
 *   in-sync       the manifest's features match the live product's
 *
 * Sightings (an SDK or CI actually reached the platform) are the console's alone: they need the
 * Worker's record of them, and `pkey doctor` reports none until that record has an API.
 * Everything read from the server is the server's words: callers clean it (`untrusted.ts`)
 * before it reaches a terminal or a job log.
 */

import { networkMessage } from "./errors.js";
import {
  findManifestRoot,
  loadManifest,
  ManifestSyntaxError,
  validateLoadedManifest,
  type LoadedManifest,
  type ValidationResult,
} from "./manifest.js";
import type { PkeyContext } from "./context.js";

export type DoctorState = "ok" | "warn" | "todo";

export interface DoctorFact {
  id: "manifest" | "discovery" | "services" | "signing-keys" | "in-sync";
  state: DoctorState;
  /** One plain sentence; for a remote fact it quotes the server, so it is cleaned on output. */
  detail: string;
  /** What to do about it, when the fact is not ok. */
  fix?: string;
}

/** A signing key the live product exposes. */
export interface SigningKey {
  kid: string;
  status: string;
}

export interface RemoteDoctor {
  url: string;
  /** The HTTP status when the server answered with a refusal. */
  status?: number;
  services: string[];
  signing: SigningKey[];
  facts: DoctorFact[];
}

/** How long a discovery answer may take before doctor gives up on it. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

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
  const fixable = result.warnings.some((w) => w.code === "deprecated_spelling");
  return {
    id: "manifest",
    state: result.warnings.length ? "warn" : "ok",
    detail: result.warnings.length
      ? `${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`
      : "valid",
    ...(fixable ? { fix: "pkey validate --fix" } : {}),
  };
}

const NETWORK_FIX = "Check the network and --base-url (or $PKEY_BASE_URL).";

function todo(
  id: DoctorFact["id"],
  detail: string,
  fix: string,
  rest: Partial<RemoteDoctor> = {},
  url = "",
): RemoteDoctor {
  return {
    url,
    services: [],
    signing: [],
    ...rest,
    facts: [{ id, state: "todo", detail, fix }],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The keys a discovery document exposes: `trust.keys` (the Worker's shape), else `signing.keys`. */
function keysOf(body: Record<string, unknown>): SigningKey[] {
  const trust = isRecord(body.trust) ? body.trust : {};
  const signing = isRecord(body.signing) ? body.signing : {};
  const raw = Array.isArray(trust.keys)
    ? trust.keys
    : Array.isArray(signing.keys)
      ? signing.keys
      : [];
  return raw.flatMap((k): SigningKey[] =>
    isRecord(k) && typeof k.kid === "string"
      ? [
          {
            kid: k.kid,
            status:
              typeof k.status === "string"
                ? k.status
                : k.active === true
                  ? "active"
                  : "unknown",
          },
        ]
      : [],
  );
}

/** Fetch the product's discovery document and read the remote facts out of it. Never throws. */
export async function checkRemote(opts: {
  baseUrl: string;
  product: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RemoteDoctor> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(opts.product)}/.well-known/polaris.json`;
  const host = base.replace(/^https?:\/\//, "");
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () =>
    todo(
      "discovery",
      `${host} did not answer in ${Math.round(timeoutMs / 1000)} s.`,
      NETWORK_FIX,
      {},
      url,
    );
  try {
    let res: Response;
    let text: string;
    try {
      res = await (opts.fetchImpl ?? fetch)(url, { signal: controller.signal });
      text = res.ok ? await res.text() : "";
    } catch (err) {
      if (controller.signal.aborted) return timedOut();
      const message = networkMessage(err, url);
      const cut = message.match(/^(.*?\.) Check your network/s);
      return todo("discovery", cut ? cut[1]! : message, NETWORK_FIX, {}, url);
    }
    if (!res.ok) {
      const fix =
        res.status === 404
          ? `Is ${opts.product} registered at ${host}?`
          : res.status >= 500
            ? "The server failed; try again."
            : `Check --base-url (or $PKEY_BASE_URL) and ${opts.product}.`;
      return todo(
        "discovery",
        res.status === 404
          ? "not found (404)"
          : res.status >= 500
            ? `server error (${res.status})`
            : `failed (${res.status})`,
        fix,
        { status: res.status },
        url,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!isRecord(body))
      return todo(
        "discovery",
        `${host} did not answer with discovery JSON.`,
        "Check --base-url (or $PKEY_BASE_URL); it must be the Polaris Key origin.",
        {},
        url,
      );
    const services = Object.entries(
      isRecord(body.services) ? body.services : {},
    )
      .filter(([, service]) => isRecord(service) && service.enabled === true)
      .map(([slug]) => slug);
    const signing = keysOf(body);
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
          ...(services.length
            ? {}
            : { fix: "Enable a feature for this product in the console." }),
        },
        {
          id: "signing-keys",
          state: signing.length ? "ok" : "todo",
          detail: signing.length
            ? `${signing.length} key${signing.length === 1 ? "" : "s"}`
            : "none",
          ...(signing.length
            ? {}
            : { fix: "Create a signing key for this product in the console." }),
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** A ▲ when the manifest and the live product enable different features, else `null`. */
export function syncFact(
  manifest: readonly string[],
  live: readonly string[],
): DoctorFact | null {
  const onlyManifest = manifest.filter((s) => !live.includes(s));
  const onlyLive = live.filter((s) => !manifest.includes(s));
  if (!onlyManifest.length && !onlyLive.length) return null;
  const parts = [
    onlyManifest.length ? `only in .pkey/: ${onlyManifest.join(", ")}` : "",
    onlyLive.length ? `only live: ${onlyLive.join(", ")}` : "",
  ].filter(Boolean);
  return {
    id: "in-sync",
    state: "warn",
    detail: `${parts.join("; ")}.`,
    fix: "Resync the product from .pkey/ in the console.",
  };
}

/** `ok` unless a fact is still to do; the process exits 1 when this is false. */
export function doctorOk(facts: readonly DoctorFact[]): boolean {
  return facts.every((f) => f.state !== "todo");
}

/** Everything doctor learned, gathered once; `--json` and the text answer both read it. */
export interface DoctorModel {
  product: { slug: string; name?: string } | null;
  baseUrl: string;
  /** The loaded manifest and its verdict, when `.pkey/` could be read. */
  loaded: LoadedManifest | null;
  result: ValidationResult | null;
  facts: DoctorFact[];
  services: string[];
  /** `null` until discovery answers. */
  signing: SigningKey[] | null;
  /** Wall-clock milliseconds the checks took. */
  ms: number;
}

/**
 * Validate the `.pkey/` found at or above `cwd` (the one `pkey help` names), then, when a product
 * is known, check its live discovery. A manifest that cannot be read does not stop the remote
 * checks. `onStage` is told what is being waited on (and `""` when done).
 */
export async function gatherDoctor(opts: {
  ctx: PkeyContext;
  cwd: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onStage?: (label: string) => void;
  now?: () => number;
}): Promise<DoctorModel> {
  const now = opts.now ?? Date.now;
  const started = now();
  const { ctx } = opts;
  let loaded: LoadedManifest | null = null;
  let result: ValidationResult | null = null;
  let problem: DoctorFact | undefined;
  try {
    loaded = await loadManifest(await findManifestRoot(opts.cwd));
    result = validateLoadedManifest(loaded);
  } catch (e) {
    const message = (e as Error).message;
    problem =
      e instanceof ManifestSyntaxError
        ? { id: "manifest", state: "todo", detail: message }
        : message.startsWith("No .pkey/product")
          ? {
              id: "manifest",
              state: "todo",
              detail: "No .pkey/product here or above.",
              fix: "Run pkey init.",
            }
          : { id: "manifest", state: "todo", detail: message };
  }
  const manifest = problem ?? manifestFact(result);
  const facts: DoctorFact[] = [manifest];
  let services: string[] = [];
  let signing: SigningKey[] | null = null;
  if (ctx.product) {
    opts.onStage?.(`Checking ${ctx.baseUrl.url.replace(/^https?:\/\//, "")}…`);
    const remote = await checkRemote({
      baseUrl: ctx.baseUrl.url,
      product: ctx.product.slug,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    opts.onStage?.("");
    facts.push(...remote.facts);
    if (remote.facts.every((f) => f.id !== "discovery" || f.state === "ok")) {
      services = remote.services;
      signing = remote.signing;
      const differ = result
        ? syncFact(result.enabledModules, remote.services)
        : null;
      if (differ) facts.push(differ);
    }
  } else {
    facts.push({
      id: "discovery",
      state: "warn",
      detail: "skipped: no product",
      fix: "Pass --product, or run where .pkey/product is.",
    });
  }
  return {
    product: ctx.product
      ? {
          slug: ctx.product.slug,
          ...(ctx.product.name ? { name: ctx.product.name } : {}),
        }
      : null,
    baseUrl: ctx.baseUrl.url,
    loaded,
    result,
    facts,
    services,
    signing,
    ms: now() - started,
  };
}

/** The counts the closing line shows: facts to do and warnings, manifest messages included. */
export function doctorCounts(model: DoctorModel): {
  todo: number;
  warnings: number;
} {
  const r = model.result;
  let todo = 0;
  let warnings = 0;
  for (const f of model.facts) {
    if (f.id === "manifest" && r) {
      todo += r.errors.length;
      warnings += r.warnings.length;
    } else if (f.state === "todo") todo += 1;
    else if (f.state === "warn") warnings += 1;
  }
  warnings += model.loaded?.fileWarnings?.length ?? 0;
  return { todo, warnings };
}
