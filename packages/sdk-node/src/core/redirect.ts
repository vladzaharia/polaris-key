// The redirect rule of WIRE-CONTRACT-V4 §5, for every product-scoped Node call.
//
//   - a same-origin hop keeps the headers;
//   - a cross-origin hop drops `Authorization` and every `X-PKey-*` header (for the rest of the
//     chain), and is followed only for GET and HEAD;
//   - a 307 or 308 on a non-GET to another origin, and any https -> http hop, is refused with
//     `insecure-redirect`; so is a target that is not http(s);
//   - more than 5 hops is `too-many-redirects`.
//
// Godot (`transport.gd`) and Kotlin (`Transport.kt`) already follow it. The wrapped fetch asks
// the underlying one for `redirect: "manual"` and follows by hand, so undici's own policy (which
// keeps `X-PKey-*` and the POST body across origins) never decides.

import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const isCredentialHeader = (name: string): boolean => {
  const n = name.toLowerCase();
  return n === "authorization" || n.startsWith("x-pkey-");
};

export function withRedirectPolicy(f: typeof fetch): typeof fetch {
  const followed = async (
    input: Parameters<typeof fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    let url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    let method = (
      init.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    let body = init.body ?? null;
    let changed = false;
    // Plain record, original key spelling: the first hop sends exactly what the caller built.
    let headers: Record<string, string> = Object.fromEntries(
      new Headers(
        init.headers ?? (input instanceof Request ? input.headers : undefined),
      ).entries(),
    );
    if (
      init.headers &&
      !(init.headers instanceof Headers) &&
      !Array.isArray(init.headers)
    )
      headers = { ...(init.headers as Record<string, string>) };
    const drop = (keep: (name: string) => boolean): void => {
      headers = Object.fromEntries(
        Object.entries(headers).filter(([k]) => keep(k)),
      );
    };
    for (let hop = 0; ; hop++) {
      const res = await f(url.toString(), {
        ...init,
        ...(changed ? { method, body } : {}),
        headers,
        redirect: "manual",
      });
      const location = res.headers.get("location");
      if (!REDIRECT_STATUSES.has(res.status) || location === null) return res;
      await res.body?.cancel().catch(() => undefined);
      if (hop >= MAX_REDIRECTS) {
        throw new PolarisError(
          ErrorCode.tooManyRedirects,
          `More than ${MAX_REDIRECTS} redirects.`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new PolarisError(
          ErrorCode.insecureRedirect,
          "The redirect target is not a usable URL.",
        );
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        throw new PolarisError(
          ErrorCode.insecureRedirect,
          `Refusing a redirect to ${next.protocol}`,
        );
      }
      if (url.protocol === "https:" && next.protocol === "http:") {
        throw new PolarisError(
          ErrorCode.insecureRedirect,
          "Refusing a redirect from https to plain http.",
        );
      }
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && method === "POST")
      ) {
        if (method !== "HEAD") method = "GET";
        body = null;
        changed = true;
        drop(
          (k) => !["content-type", "content-length"].includes(k.toLowerCase()),
        );
      }
      if (next.origin !== url.origin) {
        if (method !== "GET" && method !== "HEAD") {
          throw new PolarisError(
            ErrorCode.insecureRedirect,
            `Refusing a ${res.status} ${method} redirect to another origin.`,
          );
        }
        drop((k) => !isCredentialHeader(k));
      }
      url = next;
    }
  };
  return followed as typeof fetch;
}
