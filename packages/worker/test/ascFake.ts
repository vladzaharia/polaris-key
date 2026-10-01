/**
 * A fake App Store Connect API (P5-02) over the recorded resources in
 * `test/fixtures/asc/resources.json`. It answers exactly the calls the connector makes and
 * records every request, so a test can assert the documented request was sent:
 *
 *   GET   /v1/<type>/<id>[?include=a,b]           one resource, `included` per relationship name
 *   GET   /v1/apps/<id>/appStoreVersions          the app's versions (newest first)
 *   GET   /v1/apps/<id>/reviewSubmissions         filtered by `filter[state]`
 *   GET   /v1/builds?filter[app]=<id>             the app's builds (newest first)
 *   PATCH /v1/appStoreVersionPhasedReleases/<id>  `phasedReleaseState`
 *   PATCH /v1/betaGroups/<id>                     `publicLinkEnabled`
 *   POST  /v1/appStoreVersionReleaseRequests      the version → READY_FOR_DISTRIBUTION
 *   POST  /v1/webhooks, POST /v1/webhookPings
 *
 * Every answer carries `X-Rate-Limit: user-hour-lim:<lim>;user-hour-rem:<rem>;` (the remainder
 * drops by one per request). `fail429(n)` makes the next `n` requests answer 429
 * `RATE_LIMIT_EXCEEDED` with `Retry-After: 0`. Anything else is a 404, and a request to any host
 * but `api.appstoreconnect.apple.com` is recorded as `foreignHost` and refused.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AscResource } from "../src/services/distribution/connectors/asc/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ASC_FIXTURES = join(HERE, "fixtures", "asc");
export const APPLE_ID = "1234567890";

export function webhookFixture(name: string): string {
  return readFileSync(join(ASC_FIXTURES, "webhooks", `${name}.json`), "utf8");
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

export class AscFake {
  readonly requests: RecordedRequest[] = [];
  readonly foreignHost: string[] = [];
  private readonly store = new Map<string, AscResource>();
  rate = { limit: 3500, remaining: 3000 };
  private pending429 = 0;
  private nextWebhook = 1;

  constructor() {
    const raw = JSON.parse(
      readFileSync(join(ASC_FIXTURES, "resources.json"), "utf8"),
    ) as { resources: AscResource[] };
    for (const r of raw.resources)
      this.store.set(`${r.type}/${r.id}`, structuredClone(r));
  }

  get(type: string, id: string): AscResource {
    const r = this.store.get(`${type}/${id}`);
    if (!r) throw new Error(`fake has no ${type}/${id}`);
    return r;
  }

  /** Merge attributes into a stored resource. */
  set(type: string, id: string, attributes: Record<string, unknown>): void {
    const r = this.get(type, id);
    r.attributes = { ...r.attributes, ...attributes };
  }

  /** Replace or add one resource. */
  put(r: AscResource): void {
    this.store.set(`${r.type}/${r.id}`, structuredClone(r));
  }

  fail429(n: number): void {
    this.pending429 = n;
  }

  /** Requests other than GETs (the writes a control sends). */
  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "https://api.appstoreconnect.apple.com") {
      this.foreignHost.push(input);
      return new Response("refused", { status: 599 });
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : undefined;
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: headers.get("authorization"),
    });
    this.rate.remaining = Math.max(0, this.rate.remaining - 1);
    const rateHeader = {
      "X-Rate-Limit": `user-hour-lim:${this.rate.limit};user-hour-rem:${this.rate.remaining};`,
    };
    if (this.pending429 > 0) {
      this.pending429--;
      return new Response(
        JSON.stringify({
          errors: [
            { status: "429", code: "RATE_LIMIT_EXCEEDED", title: "Rate limit" },
          ],
        }),
        { status: 429, headers: { ...rateHeader, "Retry-After": "0" } },
      );
    }
    const res = this.route(method, url, body);
    return new Response(res.body === null ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json", ...rateHeader },
    });
  };

  private include(
    primary: AscResource[],
    include: string | null,
  ): AscResource[] {
    if (!include) return [];
    const out = new Map<string, AscResource>();
    for (const r of primary) {
      for (const name of include.split(",")) {
        const d = r.relationships?.[name]?.data;
        for (const ident of Array.isArray(d) ? d : d ? [d] : []) {
          const hit = this.store.get(`${ident.type}/${ident.id}`);
          if (hit) out.set(`${hit.type}/${hit.id}`, hit);
        }
      }
    }
    return [...out.values()];
  }

  private list(type: string, pred: (r: AscResource) => boolean): AscResource[] {
    return [...this.store.values()]
      .filter((r) => r.type === type && pred(r))
      .sort((a, b) =>
        String(
          b.attributes?.createdDate ?? b.attributes?.uploadedDate ?? "",
        ).localeCompare(
          String(a.attributes?.createdDate ?? a.attributes?.uploadedDate ?? ""),
        ),
      );
  }

  private appOf(r: AscResource): string | null {
    const d = r.relationships?.app?.data;
    return d && !Array.isArray(d) ? d.id : null;
  }

  private route(
    method: string,
    url: URL,
    body: unknown,
  ): { status: number; body: unknown } {
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
    const include = url.searchParams.get("include");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const doc = (data: AscResource[] | AscResource) => ({
      data,
      included: this.include(Array.isArray(data) ? data : [data], include),
      links: { self: url.toString() },
    });
    const notFound = {
      status: 404,
      body: { errors: [{ status: "404", code: "NOT_FOUND" }] },
    };

    if (method === "GET") {
      if (
        parts.length === 4 &&
        parts[1] === "apps" &&
        parts[3] === "appStoreVersions"
      ) {
        const app = parts[2]!;
        return {
          status: 200,
          body: doc(
            this.list("appStoreVersions", (r) => this.appOf(r) === app).slice(
              0,
              limit,
            ),
          ),
        };
      }
      if (
        parts.length === 4 &&
        parts[1] === "apps" &&
        parts[3] === "reviewSubmissions"
      ) {
        const app = parts[2]!;
        const states =
          url.searchParams.get("filter[state]")?.split(",") ?? null;
        return {
          status: 200,
          body: doc(
            this.list(
              "reviewSubmissions",
              (r) =>
                this.appOf(r) === app &&
                (!states || states.includes(String(r.attributes?.state))),
            ).slice(0, limit),
          ),
        };
      }
      if (parts.length === 2 && parts[1] === "builds") {
        const app = url.searchParams.get("filter[app]");
        return {
          status: 200,
          body: doc(
            this.list("builds", (r) => this.appOf(r) === app).slice(0, limit),
          ),
        };
      }
      if (parts.length === 3) {
        const r = this.store.get(`${parts[1]}/${parts[2]}`);
        return r ? { status: 200, body: doc(r) } : notFound;
      }
      return notFound;
    }

    const data =
      (body as { data?: Record<string, unknown> } | undefined)?.data ?? {};
    if (method === "PATCH" && parts.length === 3) {
      const r = this.store.get(`${parts[1]}/${parts[2]}`);
      if (!r || data.id !== r.id || data.type !== r.type) return notFound;
      r.attributes = {
        ...r.attributes,
        ...(data.attributes as Record<string, unknown>),
      };
      if (
        r.type === "appStoreVersionPhasedReleases" &&
        r.attributes.phasedReleaseState === "COMPLETE"
      )
        r.attributes.currentDayNumber = 7;
      return { status: 200, body: { data: r } };
    }
    if (method === "POST" && parts.length === 2) {
      if (parts[1] === "appStoreVersionReleaseRequests") {
        const rels = data.relationships as Record<
          string,
          { data: { id: string } }
        >;
        const v = this.store.get(
          `appStoreVersions/${rels.appStoreVersion?.data.id}`,
        );
        if (!v || v.attributes?.appVersionState !== "PENDING_DEVELOPER_RELEASE")
          return {
            status: 409,
            body: { errors: [{ status: "409", code: "STATE_ERROR" }] },
          };
        v.attributes = {
          ...v.attributes,
          appVersionState: "READY_FOR_DISTRIBUTION",
          appStoreState: "READY_FOR_SALE",
        };
        return {
          status: 201,
          body: {
            data: { type: "appStoreVersionReleaseRequests", id: "rr-1" },
          },
        };
      }
      if (parts[1] === "webhooks") {
        const id = `wh-${this.nextWebhook++}`;
        const attrs = data.attributes as Record<string, unknown>;
        const created: AscResource = {
          type: "webhooks",
          id,
          attributes: {
            enabled: attrs.enabled,
            eventTypes: attrs.eventTypes,
            name: attrs.name,
            url: attrs.url,
          },
          relationships: data.relationships as AscResource["relationships"],
        };
        this.store.set(`webhooks/${id}`, created);
        return { status: 201, body: { data: created } };
      }
      if (parts[1] === "webhookPings")
        return {
          status: 201,
          body: { data: { type: "webhookPings", id: "whp-1" } },
        };
    }
    return notFound;
  }
}
