// The link offer (identity.link; WIRE-CONTRACT-V5 §12.11.4): after a redirect sign-in the page
// reads which platform identities the account could add, and links one on the person's yes.
// Loaded on demand, only after a redirect sign-in; nothing here runs at boot.
//
//   offer()    GET link (device bearer)
//   accept()   POST link, with the held handle (no second provider prompt), or with a fresh
//              provider token and nonce (one prompt); the proof's purpose is `link`
//   decline    remembered as sha256(issuer ‖ sub) on this device, never the identity itself
//
// The handle and the provider token never reach a log or a message. The engine behind the
// adapter's `link` (`createLinkClient`) is at the end of this file: one lazy chunk.

import { signDeviceProof, type DeviceKeyPort } from "@polaris-key/client-core";
import {
  LINK_HANDLE_PATTERN,
  type ExchangeKind,
} from "@polaris-key/protocol/identity";
import { ErrorCode } from "../../constants.generated.js";
import type {
  LinkAcceptResult,
  LinkClient,
  LinkOfferEntry,
  LinkOfferResult,
} from "../../core/link.js";
import { redirectEndpointsOf } from "../../core/signIn.js";
import type { PlatformIdentityProvider } from "../../core/signIn.js";
import type { BearerSession } from "./session.js";
import type { BrowserStore } from "./store.js";
import { bodyCode } from "../../core/activation.js";
import { PolarisError } from "../../core/types.js";
import type { ExchangeDiscovery } from "../discovery.js";
import {
  isRecord,
  readJson,
  refusal,
  requestNonce,
  sameOrigin,
  sha256Base64Url,
} from "./exchange.js";

export type { LinkAcceptResult, LinkOfferEntry, LinkOfferResult };
type LinkOffer = LinkOfferResult;
type LinkAccept = LinkAcceptResult;

export interface LinkContext {
  product: string;
  deviceId: string;
  /** Discovery's platform sign-in, or `null`. */
  endpoints: ExchangeDiscovery | null;
  baseUrl: string;
  bearer(): string | null;
  headers(extra: Record<string, string>): Record<string, string>;
  send(url: string, init: RequestInit): Promise<Response>;
  now(): number;
}

export type LinkAcceptOptions =
  | {
      linkHandle: string;
      /** Conformance replay only: the value the proof is signed over (default: the handle). */
      proofValue?: string;
    }
  | {
      kind: ExchangeKind;
      /** The provider's ID token for `nonce`, signed in as is. Called once. */
      subjectToken(nonce: string): Promise<string>;
    };

const REFUSED = new Set<string>([
  ErrorCode.stepUpRequired,
  ErrorCode.linkConflict,
  ErrorCode.invalidGrant,
  ErrorCode.notFound,
]);

function endpointOf(ctx: LinkContext): string | null {
  const url = ctx.endpoints?.linkEndpoint;
  // Discovery is data the network supplied: the bearer goes only to the product's own origin.
  return url !== undefined && sameOrigin(ctx.baseUrl, url) ? url : null;
}

function offerEntry(v: unknown): LinkOfferEntry | null {
  if (!isRecord(v) || (v.kind !== "google" && v.kind !== "apple")) return null;
  const reach =
    v.reach === "global" || v.reach === "developer" ? v.reach : null;
  return { kind: v.kind, reach };
}

/** The context of a link call: the session's device, endpoints and transport, and its token. */
export async function linkContextOf(b: BearerSession): Promise<LinkContext> {
  await b.init();
  return { ...b.wire(), bearer: () => b.bearer };
}

/** `GET link`: the kinds the account could add. */
export async function runOffer(ctx: LinkContext): Promise<LinkOffer> {
  const url = endpointOf(ctx);
  const token = ctx.bearer();
  if (url === null || token === null) return { kind: "unavailable" };
  let res: Response;
  try {
    res = await ctx.send(url, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      headers: ctx.headers({ authorization: `Bearer ${token}` }),
    });
  } catch (e) {
    throw new PolarisError(ErrorCode.networkError, (e as Error).message);
  }
  const body = await readJson(res);
  if (res.status === 404) return { kind: "unavailable" };
  if (res.status !== 200) throw refusal("link offer", res, body);
  if (!isRecord(body) || !Array.isArray(body.offer))
    throw refusal("link offer", res, body, true);
  return {
    kind: "ok",
    offer: body.offer.flatMap((e) => offerEntry(e) ?? []),
  };
}

/** `POST link`: one proof, one request. A handle is spent by the attempt that uses it. */
export async function runAccept(
  ctx: LinkContext,
  port: DeviceKeyPort,
  opts: LinkAcceptOptions,
): Promise<LinkAccept> {
  const url = endpointOf(ctx);
  const bearer = ctx.bearer();
  if (url === null || bearer === null) return { kind: "unavailable" };
  const found = ctx.endpoints!;
  const headers = (type: string) =>
    ctx.headers({ authorization: `Bearer ${bearer}`, "content-type": type });
  const fail = (e: unknown): never => {
    throw e instanceof PolarisError
      ? e
      : new PolarisError(
          ErrorCode.signInFailed,
          "the device proof could not be signed.",
        );
  };

  let body: Record<string, string>;
  if ("linkHandle" in opts) {
    if (!new RegExp(LINK_HANDLE_PATTERN).test(opts.linkHandle))
      return { kind: "refused", status: 404, code: ErrorCode.notFound };
    try {
      const proof = await signDeviceProof(port, {
        purpose: "link",
        product: ctx.product,
        deviceId: ctx.deviceId,
        value: opts.proofValue ?? opts.linkHandle,
        tokenHash: "-",
        now: ctx.now(),
      });
      body = { linkHandle: opts.linkHandle, proof: proof.sig };
    } catch (e) {
      return fail(e);
    }
  } else {
    if (
      !found.kinds.includes(opts.kind) ||
      !sameOrigin(ctx.baseUrl, found.nonceEndpoint)
    )
      return { kind: "unavailable" };
    let keys;
    try {
      keys = await port.ensure();
    } catch (e) {
      return fail(e);
    }
    const nonce = await requestNonce(ctx, found.nonceEndpoint, keys, "link");
    if (nonce === null) return { kind: "unavailable" };
    const subjectToken = await opts.subjectToken(nonce);
    if (typeof subjectToken !== "string" || subjectToken === "")
      throw new PolarisError(
        ErrorCode.signInFailed,
        "the platform provider returned no token.",
      );
    try {
      const proof = await signDeviceProof(port, {
        purpose: "link",
        product: ctx.product,
        deviceId: ctx.deviceId,
        value: `${nonce}.${keys.signKey}`,
        tokenHash: await sha256Base64Url(subjectToken),
        now: ctx.now(),
      });
      body = {
        subjectToken,
        nonce,
        signKey: keys.signKey,
        agreeKey: keys.agreeKey,
        proof: proof.sig,
      };
    } catch (e) {
      return fail(e);
    }
  }

  let res: Response;
  try {
    res = await ctx.send(url, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: headers("application/json"),
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new PolarisError(ErrorCode.networkError, (e as Error).message);
  }
  const answer = await readJson(res);
  if (res.status === 200) {
    const linked = isRecord(answer) ? answer.linked : undefined;
    const kind = isRecord(linked) ? linked.kind : undefined;
    if (!isRecord(linked) || (kind !== "google" && kind !== "apple"))
      throw refusal("link", res, answer, true);
    return {
      kind: "linked",
      linked: {
        kind,
        reach: typeof linked.reach === "string" ? linked.reach : null,
      },
    };
  }
  const code = bodyCode(answer);
  if (res.status < 500 && code !== null && REFUSED.has(code))
    return { kind: "refused", status: res.status, code };
  throw refusal("link", res, answer);
}

/** What the offer is remembered under once declined: a hash, so the store never holds the
 *  identity. `issuer` is the product's identity issuer, `sub` the account's pairwise subject. */
export function declineHash(issuer: string, sub: string): Promise<string> {
  return sha256Base64Url(`${issuer}${sub}`);
}

/** The `no_link` handle lives 600 s. */
const HANDLE_SECONDS = 600;

/** The browser adapter's own members the engine reads (it is created with the adapter itself, so
 *  the adapter carries no table of accessors); named as the adapter has them. */
export interface LinkHost {
  product: string;
  base: string;
  bearer: BearerSession | null;
  bearerStore: BrowserStore | null;
  configError: unknown;
  discovery_: Record<string, unknown> | null;
  clock(): number;
  ensureDiscovery(): Promise<unknown>;
  deviceKeyPort(): Promise<DeviceKeyPort>;
  platformProvider(
    m: typeof import("./autoSignIn.js"),
  ): PlatformIdentityProvider | null;
}

export function createLinkClient(host: LinkHost): LinkClient {
  const h = {
    key: `pkey-link:${host.product}`,
    clock: () => host.clock(),
    bearer: () => host.bearer,
    store: () => host.bearerStore,
    ready: () => (host.configError ? null : host.ensureDiscovery()),
    issuer: () =>
      redirectEndpointsOf(host.discovery_)?.issuer ??
      `${host.base}/${host.product}/identity`,
    port: () => host.deviceKeyPort(),
    provider: async () =>
      host.platformProvider(await import("./autoSignIn.js")),
  };
  const held = (): string | null => {
    try {
      const raw = sessionStorage.getItem(h.key);
      const o = (raw === null ? null : JSON.parse(raw)) as {
        h?: unknown;
        at?: unknown;
      } | null;
      return o !== null &&
        typeof o.h === "string" &&
        typeof o.at === "number" &&
        h.clock() - o.at < HANDLE_SECONDS
        ? o.h
        : null;
    } catch {
      return null;
    }
  };
  const drop = (): void => {
    try {
      sessionStorage.removeItem(h.key);
    } catch {
      // nothing to drop
    }
  };
  /** `sha256(issuer ‖ sub)`. */
  const key = async (b: BearerSession): Promise<string> =>
    declineHash(
      h.issuer(),
      b.account ?? (await b.subject().catch(() => null)) ?? "",
    );

  const client: LinkClient = {
    pending: () => held() !== null,
    mark(handle) {
      try {
        // A handle (kept 600 s, across the sign-in redirect) replaces the marker; a landed
        // sign-in only makes one when there is none.
        if (handle !== undefined || sessionStorage.getItem(h.key) === null)
          sessionStorage.setItem(
            h.key,
            JSON.stringify({ h: handle, at: h.clock() }),
          );
      } catch {
        // No storage: the offer falls back to a fresh provider token.
      }
    },
    async offer(): Promise<LinkOfferResult> {
      const b = h.bearer();
      const ready = h.ready();
      if (ready === null || !b) return { kind: "unavailable" };
      await ready;
      return runOffer(await linkContextOf(b));
    },
    async declined() {
      const b = h.bearer();
      const flags = h.store()?.flags;
      if (!b || !flags) return false;
      try {
        return await flags.getFlag(`declined\0${await key(b)}`);
      } catch {
        return false;
      }
    },
    async accept(): Promise<LinkAcceptResult> {
      const b = h.bearer();
      const ready = h.ready();
      if (ready === null || !b) return { kind: "unavailable" };
      await ready;
      const port = await h.port();
      const handle = held();
      let r: LinkAcceptResult;
      if (handle !== null)
        r = await runAccept(await linkContextOf(b), port, {
          linkHandle: handle,
        });
      else {
        const provider = await h.provider();
        if (provider === null || !provider.available())
          return { kind: "unavailable" };
        const none = new Error("no provider token");
        try {
          r = await runAccept(await linkContextOf(b), port, {
            kind: provider.kind,
            subjectToken: async (nonce) => {
              const t = await provider.token(nonce, "optional");
              if (t === null) throw none;
              return t;
            },
          });
        } catch (e) {
          if (e === none) return { kind: "unavailable" };
          throw e;
        }
      }
      // A stale step-up leaves the handle where it is (the person signs in again); anything
      // else spends it.
      if (!(r.kind === "refused" && r.code === ErrorCode.stepUpRequired)) {
        drop();
      }
      // An identity that belongs to another account is not offered again here.
      if (r.kind === "refused" && r.code === ErrorCode.linkConflict)
        await client.decline();
      return r;
    },
    async decline() {
      drop();
      const b = h.bearer();
      const flags = h.store()?.flags;
      if (!b || !flags) return;
      try {
        await flags.setFlag(true, `declined\0${await key(b)}`);
      } catch {
        // A store that cannot keep it asks again next time.
      }
    },
  };
  return client;
}
