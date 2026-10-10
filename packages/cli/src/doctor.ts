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
 * Sightings (an SDK or CI actually reached the platform) are the console's alone: they need the
 * Worker's record of them, and `pkey doctor` reports none until that record has an API.
 * Everything read from the server is the server's words: callers clean it (`untrusted.ts`)
 * before it reaches a terminal or a job log.
 */

import type { ValidationResult } from "./manifest.js";

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
}): Promise<RemoteDoctor> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(opts.product)}/.well-known/polaris.json`;
  const res = await (opts.fetchImpl ?? fetch)(url);
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
