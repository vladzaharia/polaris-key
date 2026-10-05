/**
 * The gated Steamworks Web API client (A-18g; notes/S-15 §4.3, §6.2, §6.3). Every call the Steam
 * storefront adapter makes goes through `SteamClient.request`:
 *
 *   - **The gate first.** `checkSteamRequest` (`core/storefront/rules/steam.ts`) admits three reads
 *     and one write (`SetAppBuildLive` on a named branch) BEFORE the key thunk runs: a refused
 *     request throws `SteamWriteDenied`, so the publisher key is never opened (no audited open,
 *     no byte sent).
 *   - **The budget next.** The meter (an injected `SteamBudget`, the shared `budget.ts` per-day
 *     counter on the key's slot) is read before the key is opened: while Steam has stopped the
 *     Worker (a 403 earlier in the window) nothing is sent, whoever asks. Every call that is sent
 *     counts against the 100,000 a day.
 *   - **A 403 stops everything.** "Requests generating 403 status codes … will incur strict rate
 *     limits for the connecting IP", and that IP is the Worker's shared egress: the FIRST 403 stops
 *     the meter until the day's window ends (`stopOn403`), then throws `StoreVendorError(403)`.
 *   - **Fixed host.** `https://partner.steam-api.com`, the publisher host a publisher key requires.
 *     The path is the gate's own (`/<Interface>/<Method>/v<N>/`), so nothing a caller supplies
 *     can name another host.
 *   - **The key rides where Steam wants it** (a query parameter on a read, a form field on a
 *     write), so no error carries a URL or a body: a status and a fixed token only.
 *   - **No redirects, bounded bodies** (`redirect: "manual"`, `readCappedText`).
 *
 * The response shapes of `GetAppBuilds` and `GetAppBetas` are not documented by Valve; the parsers
 * below accept the shapes the community documents and drop anything else. A-18k confirms them
 * against the owner's key (S-15 §12).
 */

import { isRedirect, readCappedText } from "../readCapped.js";
import { StoreVendorError } from "../storefront/errors.js";
import type { GateContext } from "../storefront/gate.js";
import {
  checkSteamRequest,
  STEAM_READS,
  STEAM_SET_LIVE,
} from "../storefront/rules/steam.js";

export { SteamWriteDenied } from "../storefront/rules/steam.js";

export const STEAM_WEB_API = "https://partner.steam-api.com";

/** The most of one Steam answer read (a build list of 100 entries fits easily). */
export const MAX_STEAM_RESPONSE_BYTES = 512 * 1024;

export type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** The meter the client consults and feeds (`budget.ts`'s `BudgetMeter`, narrowed). */
export interface SteamBudget {
  /** Whether Steam has stopped the Worker (a 403 earlier in the window). */
  stopped(): Promise<boolean>;
  /** Count one call. */
  spend(): Promise<void>;
  /** Stop every call until the window ends. */
  stop(): Promise<void>;
}

export interface SteamClientOptions {
  /** Opens the publisher key; called only after the gate and the budget admit the request. */
  key: () => Promise<string>;
  fetchImpl?: FetchImpl;
  budget?: SteamBudget;
}

/** A positive decimal id (`appid`, `buildid`). */
export const STEAM_NUMERIC_ID = /^[1-9][0-9]{0,9}$/;

export class SteamClient {
  readonly #key: () => Promise<string>;
  readonly #fetch: FetchImpl;
  readonly #budget: SteamBudget | null;

  constructor(o: SteamClientOptions) {
    this.#key = o.key;
    this.#fetch = o.fetchImpl ?? ((i, init) => fetch(i, init));
    this.#budget = o.budget ?? null;
  }

  /**
   * One call. `params` are the method's parameters without the key: a read's query, a write's
   * form fields (the gate matches exactly these). Answers the JSON object Steam returned.
   */
  async request(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string> = {},
    ctx: GateContext = {},
  ): Promise<Record<string, unknown>> {
    // 1. The gate (pure; throws SteamWriteDenied).
    checkSteamRequest(method, path, method === "GET" ? undefined : params, ctx);
    if (method === "GET")
      for (const [k, v] of Object.entries(params))
        if (!/^[a-z_]{1,32}$/.test(k) || v.length > 256)
          throw new StoreVendorError(400, "invalid_parameter", "steam: invalid read parameter");
    // 2. The budget.
    if (this.#budget && (await this.#budget.stopped()))
      throw new StoreVendorError(
        429,
        "budget_stopped",
        "steam: calls are stopped after a 403 until the day's window ends",
      );
    // 3. The key, only now.
    const key = await this.#key();
    const url = new URL(path, STEAM_WEB_API);
    if (url.origin !== STEAM_WEB_API)
      throw new StoreVendorError(400, "invalid_path", "steam: refusing another host");
    const fields = new URLSearchParams({ key, ...params });
    let init: RequestInit;
    if (method === "GET") {
      url.search = fields.toString();
      init = { method, headers: { accept: "application/json" } };
    } else {
      init = {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: fields.toString(),
      };
    }
    await this.#budget?.spend().catch(() => undefined);
    let res: Response;
    try {
      res = await this.#fetch(url.toString(), { ...init, redirect: "manual" });
    } catch {
      throw new StoreVendorError(0, null, `steam ${label(path)}: network failure`);
    }
    if (res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      await this.#budget?.stop().catch(() => undefined);
      throw new StoreVendorError(403, "forbidden", `steam ${label(path)}: HTTP 403`);
    }
    const ok = res.status >= 200 && res.status < 300;
    if (isRedirect(res) || !ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new StoreVendorError(
        res.status,
        null,
        `steam ${label(path)}: HTTP ${res.status}`,
      );
    }
    let text: string;
    try {
      text = await readCappedText(
        res,
        MAX_STEAM_RESPONSE_BYTES,
        () => new StoreVendorError(502, "too_large", `steam ${label(path)}: answer too large`),
      );
    } catch (e) {
      if (e instanceof StoreVendorError) throw e;
      throw new StoreVendorError(502, null, `steam ${label(path)}: unreadable answer`);
    }
    if (text.trim() === "") return {};
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v))
        return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    throw new StoreVendorError(502, null, `steam ${label(path)}: unreadable answer`);
  }

  /** `GetPartnerAppListForWebAPIKey`: the apps this key may act on. */
  async apps(): Promise<SteamApp[]> {
    return parseApps(await this.request("GET", STEAM_READS.apps));
  }

  /** `GetAppBuilds`: the app's newest builds (at most `count`, Steam's default 10). */
  async builds(appId: string, count = 20): Promise<SteamBuild[]> {
    return parseBuilds(
      await this.request("GET", STEAM_READS.builds, {
        appid: appId,
        count: String(Math.max(1, Math.min(100, Math.trunc(count)))),
      }),
    );
  }

  /** `GetAppBetas`: every branch of the app (the default branch is `public`). */
  async betas(appId: string): Promise<SteamBranch[]> {
    return parseBetas(
      await this.request("GET", STEAM_READS.betas, { appid: appId }),
    );
  }

  /**
   * `SetAppBuildLive` on a NAMED branch (the gate refuses `public`). Steam answers 2xx when it
   * accepted the call; the caller confirms by re-reading `GetAppBetas`, never by the answer.
   */
  async setBuildLive(
    appId: string,
    buildId: string,
    branch: string,
    description?: string,
  ): Promise<void> {
    const params: Record<string, string> = {
      appid: appId,
      buildid: buildId,
      betakey: branch,
    };
    if (description) params.description = description;
    const body = await this.request("POST", STEAM_SET_LIVE, params);
    const r = body.response;
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      if (o.success === false || (typeof o.result === "number" && o.result !== 1))
        throw new StoreVendorError(422, "set_live_refused", "steam SetAppBuildLive: refused");
    }
  }
}

function label(path: string): string {
  return path.split("/").filter(Boolean).slice(0, 2).join(".");
}

export interface SteamApp {
  appId: string;
  name: string | null;
  appType: string | null;
}

export interface SteamBuild {
  buildId: string;
  description: string | null;
  /** Epoch seconds. */
  createdAt: number | null;
}

export interface SteamBranch {
  name: string;
  /** The build live on the branch, or null when none is. */
  buildId: string | null;
  description: string | null;
  updatedAt: number | null;
  /** The branch needs a password (or is otherwise not open to every owner). */
  locked: boolean;
}

const MAX_ITEMS = 200;

function idOf(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : v;
  return typeof s === "string" && STEAM_NUMERIC_ID.test(s) ? s : null;
}
const text = (v: unknown, max = 200): string | null =>
  typeof v === "string" ? v.slice(0, max) : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (k in o) return o[k];
  return undefined;
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** `{applist: {apps: {app: [{appid, app_type, app_name}]}}}` (documented, v2). */
export function parseApps(body: Record<string, unknown>): SteamApp[] {
  const list = obj(obj(body.applist)?.apps)?.app;
  const out: SteamApp[] = [];
  for (const a of Array.isArray(list) ? list.slice(0, 1000) : []) {
    const r = obj(a);
    const appId = r ? idOf(r.appid) : null;
    if (!r || !appId) continue;
    out.push({ appId, name: text(r.app_name), appType: text(r.app_type, 32) });
  }
  return out;
}

/**
 * `{response: {builds: {<id>: {BuildID, Description, CreationTime, …}}}}` (or an array). The
 * creator's account id is dropped: it names a person.
 */
export function parseBuilds(body: Record<string, unknown>): SteamBuild[] {
  const builds = obj(body.response)?.builds;
  const entries = Array.isArray(builds)
    ? builds
    : Object.values(obj(builds) ?? {});
  const out: SteamBuild[] = [];
  for (const b of entries.slice(0, MAX_ITEMS)) {
    const r = obj(b);
    const buildId = r ? idOf(pick(r, "BuildID", "buildid", "build_id")) : null;
    if (!r || !buildId) continue;
    out.push({
      buildId,
      description: text(pick(r, "Description", "description")),
      createdAt: num(pick(r, "CreationTime", "creation_time", "time_created")),
    });
  }
  return out.sort((a, b) => Number(b.buildId) - Number(a.buildId));
}

/** `{response: {betas: {<name>: {BuildID, Description, ReqPassword, TimeUpdated, …}}}}` (or an array). */
export function parseBetas(body: Record<string, unknown>): SteamBranch[] {
  const betas = obj(body.response)?.betas;
  const entries: Array<[string | null, unknown]> = Array.isArray(betas)
    ? betas.map((b) => [null, b])
    : Object.entries(obj(betas) ?? {});
  const out: SteamBranch[] = [];
  for (const [key, b] of entries.slice(0, MAX_ITEMS)) {
    const r = obj(b);
    if (!r) continue;
    const name = key ?? text(pick(r, "Name", "name"), 64);
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) continue;
    const req = pick(r, "ReqPassword", "req_password", "requires_password");
    out.push({
      name,
      buildId: idOf(pick(r, "BuildID", "buildid", "build_id")),
      description: text(pick(r, "Description", "description")),
      updatedAt: num(pick(r, "TimeUpdated", "time_updated", "updated")),
      locked: req === true || req === 1,
    });
  }
  return out;
}
