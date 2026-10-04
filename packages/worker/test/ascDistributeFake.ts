/**
 * A-17d — the fake App Store Connect API, extended with the calls the Distribute flow makes
 * (`connectors/asc/distribute.ts`). Everything P5-02's `AscFake` answers still goes to it; this
 * adds, as the real API answers them:
 *
 *   GET   /v1/{builds,betaBuildLocalizations,betaAppReviewSubmissions,reviewSubmissions}
 *                                     `filter[<attribute|relationship|id>]=a,b`, `include`, `limit`
 *   GET   /v1/<parent>/<id>/<children> the to-many collections in `CHILDREN`, filtered the same way
 *   POST  /v1/<type>                   a create: Apple's initial state per type; a duplicate
 *                                      version, or a second open review submission per platform,
 *                                      answers 409 `ENTITY_ERROR.ATTRIBUTE.INVALID`
 *   POST  /v1/betaGroups/{id}/relationships/builds      204, the builds join the group
 *   PATCH /v1/appStoreVersions/{id}/relationships/build 204, the version names the build
 *   PATCH /v1/reviewSubmissions/{id}   `submitted` → WAITING_FOR_REVIEW, `canceled` → CANCELING
 *
 * `failOnce(method, path, status, { applied })` makes the next matching request answer `status`
 * (with Apple's error shape), after performing the write when `applied` (a timeout or 5xx after
 * the write landed: an ambiguous outcome) or without it.
 */

import type { AscResource } from "../src/core/asc/client.js";
import { AscFake } from "./ascFake.js";

/** `<parentType>/<relationship>` → the child type and the child's relationship to the parent. */
const CHILDREN: Readonly<Record<string, [string, string]>> = {
  "apps/appStoreVersions": ["appStoreVersions", "app"],
  "apps/betaGroups": ["betaGroups", "app"],
  "apps/appInfos": ["appInfos", "app"],
  "apps/betaAppLocalizations": ["betaAppLocalizations", "app"],
  "appStoreVersions/appStoreVersionLocalizations": [
    "appStoreVersionLocalizations",
    "appStoreVersion",
  ],
  "appStoreVersionLocalizations/appScreenshotSets": [
    "appScreenshotSets",
    "appStoreVersionLocalization",
  ],
  "reviewSubmissions/items": ["reviewSubmissionItems", "reviewSubmission"],
};

const COLLECTIONS = new Set([
  "builds",
  "betaBuildLocalizations",
  "betaAppReviewSubmissions",
  "reviewSubmissions",
]);

/** P5-02's fake answers these creates itself. */
const BASE_CREATES = new Set([
  "appStoreVersionReleaseRequests",
  "webhooks",
  "webhookPings",
]);

const INITIAL: Readonly<Record<string, Record<string, unknown>>> = {
  appStoreVersions: {
    appVersionState: "PREPARE_FOR_SUBMISSION",
    appStoreState: "PREPARE_FOR_SUBMISSION",
    releaseType: "AFTER_APPROVAL",
  },
  reviewSubmissions: { state: "READY_FOR_REVIEW" },
  reviewSubmissionItems: { state: "READY_FOR_REVIEW" },
  betaAppReviewSubmissions: { betaReviewState: "WAITING_FOR_REVIEW" },
};

type Routed = { status: number; body: unknown };

const conflict = (code = "ENTITY_ERROR.ATTRIBUTE.INVALID"): Routed => ({
  status: 409,
  body: { errors: [{ status: "409", code, title: "free text never kept" }] },
});

function idsOf(rel: unknown): string[] {
  const d = (rel as { data?: unknown } | undefined)?.data;
  const list = Array.isArray(d) ? d : d ? [d] : [];
  return list.flatMap((x) =>
    x && typeof (x as { id?: unknown }).id === "string"
      ? [(x as { id: string }).id]
      : [],
  );
}

export class DistributeFake extends AscFake {
  private nextId = 1;
  private failure: {
    method: string;
    path: string;
    status: number;
    applied: boolean;
  } | null = null;

  failOnce(
    method: string,
    path: string,
    status: number,
    opts: { applied?: boolean } = {},
  ): void {
    this.failure = { method, path, status, applied: opts.applied === true };
  }

  /** Every stored resource of a type. */
  all(type: string): AscResource[] {
    return [...this.store.values()].filter((r) => r.type === type);
  }

  private matches(r: AscResource, url: URL): boolean {
    for (const [k, v] of url.searchParams) {
      const m = /^filter\[(.+)\]$/.exec(k);
      if (!m) continue;
      const key = m[1]!;
      const vals = v.split(",");
      if (key === "id") {
        if (!vals.includes(r.id)) return false;
      } else if (r.attributes && key in r.attributes) {
        if (!vals.includes(String(r.attributes[key]))) return false;
      } else if (r.relationships && key in r.relationships) {
        if (!idsOf(r.relationships[key]).some((id) => vals.includes(id)))
          return false;
      } else return false;
    }
    return true;
  }

  private collection(url: URL, rows: AscResource[]): Routed {
    const include = url.searchParams.get("include");
    const names = new Set(include ? include.split(",") : []);
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const data = rows.filter((r) => this.matches(r, url)).slice(0, limit);
    return {
      status: 200,
      body: {
        data: data.map((r) => this.view(r, names)),
        included: this.include(data, include).map((r) =>
          this.view(r, new Set()),
        ),
        links: { self: url.toString() },
      },
    };
  }

  private relate(
    r: AscResource,
    name: string,
    value: { type: string; id: string } | null,
    many = false,
  ): void {
    r.relationships ??= {};
    if (!many) {
      r.relationships[name] = { data: value };
      return;
    }
    const cur = r.relationships[name]?.data;
    const list = Array.isArray(cur) ? cur : [];
    if (value && !list.some((x) => x.id === value.id)) list.push(value);
    r.relationships[name] = { data: list };
  }

  private create(type: string, data: Record<string, unknown>): Routed {
    const attributes = {
      ...(INITIAL[type] ?? {}),
      ...((data.attributes as Record<string, unknown> | undefined) ?? {}),
    };
    const relationships = (data.relationships ??
      {}) as AscResource["relationships"] & object;
    const appId = idsOf(relationships.app)[0];
    if (type === "appStoreVersions") {
      const dup = this.all("appStoreVersions").some(
        (v) =>
          this.appOf(v) === appId &&
          v.attributes?.versionString === attributes.versionString &&
          v.attributes?.platform === attributes.platform,
      );
      if (dup) return conflict();
    }
    if (type === "reviewSubmissions") {
      const open = this.all("reviewSubmissions").some(
        (s) =>
          this.appOf(s) === appId &&
          s.attributes?.platform === attributes.platform &&
          ["READY_FOR_REVIEW", "UNRESOLVED_ISSUES"].includes(
            String(s.attributes?.state),
          ),
      );
      if (open) return conflict("STATE_ERROR");
    }
    const id = `${type}-new-${this.nextId++}`;
    const created: AscResource = {
      type,
      id,
      attributes: { ...attributes, createdDate: "2026-10-04T12:00:00.000Z" },
      relationships: structuredClone(relationships),
    };
    this.store.set(`${type}/${id}`, created);
    const ident = { type, id };
    if (type === "appStoreVersionPhasedReleases") {
      const v = this.store.get(
        `appStoreVersions/${idsOf(relationships.appStoreVersion)[0]}`,
      );
      if (v) this.relate(v, "appStoreVersionPhasedRelease", ident);
    }
    if (type === "appStoreVersionLocalizations") {
      const v = this.store.get(
        `appStoreVersions/${idsOf(relationships.appStoreVersion)[0]}`,
      );
      if (v) this.relate(v, "appStoreVersionLocalizations", ident, true);
    }
    return { status: 201, body: { data: created } };
  }

  protected override route(method: string, url: URL, body: unknown): Routed {
    const f = this.failure;
    if (f && f.method === method && f.path === url.pathname) {
      this.failure = null;
      if (f.applied) this.distribute(method, url, body);
      return {
        status: f.status,
        body: {
          errors: [
            {
              status: String(f.status),
              code:
                f.status === 409
                  ? "ENTITY_ERROR.ATTRIBUTE.INVALID"
                  : "UNEXPECTED_ERROR",
              title: "free text never kept",
            },
          ],
        },
      };
    }
    return this.distribute(method, url, body);
  }

  private distribute(method: string, url: URL, body: unknown): Routed {
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
    const data =
      (body as { data?: unknown } | undefined)?.data ?? ({} as unknown);
    if (method === "GET") {
      if (parts.length === 2 && COLLECTIONS.has(parts[1]!))
        return this.collection(
          url,
          this.list(parts[1]!, () => true),
        );
      if (parts.length === 4) {
        const child = CHILDREN[`${parts[1]}/${parts[3]}`];
        if (child) {
          const [type, back] = child;
          return this.collection(
            url,
            this.list(
              type,
              (r) => idsOf(r.relationships?.[back])[0] === parts[2],
            ),
          );
        }
      }
      return super.route(method, url, body);
    }
    if (
      method === "POST" &&
      parts.length === 5 &&
      parts[1] === "betaGroups" &&
      parts[3] === "relationships" &&
      parts[4] === "builds"
    ) {
      const group = this.store.get(`betaGroups/${parts[2]}`);
      if (!group) return super.route(method, url, body);
      for (const id of idsOf({ data })) {
        const b = this.store.get(`builds/${id}`);
        if (b)
          this.relate(
            b,
            "betaGroups",
            { type: "betaGroups", id: group.id },
            true,
          );
      }
      return { status: 204, body: null };
    }
    if (
      method === "PATCH" &&
      parts.length === 5 &&
      parts[1] === "appStoreVersions" &&
      parts[3] === "relationships" &&
      parts[4] === "build"
    ) {
      const v = this.store.get(`appStoreVersions/${parts[2]}`);
      const buildId = idsOf({ data })[0];
      if (!v || !buildId) return super.route(method, url, body);
      this.relate(v, "build", { type: "builds", id: buildId });
      return { status: 204, body: null };
    }
    if (
      method === "PATCH" &&
      parts.length === 3 &&
      parts[1] === "reviewSubmissions"
    ) {
      const s = this.store.get(`reviewSubmissions/${parts[2]}`);
      const attrs =
        (data as { attributes?: Record<string, unknown> }).attributes ?? {};
      if (!s) return super.route(method, url, body);
      if (attrs.submitted === true) {
        if (s.attributes?.state !== "READY_FOR_REVIEW")
          return conflict("STATE_ERROR");
        s.attributes = {
          ...s.attributes,
          state: "WAITING_FOR_REVIEW",
          submittedDate: "2026-10-04T12:30:00.000Z",
        };
        for (const item of this.all("reviewSubmissionItems"))
          if (idsOf(item.relationships?.reviewSubmission)[0] === s.id) {
            const v = this.store.get(
              `appStoreVersions/${idsOf(item.relationships?.appStoreVersion)[0]}`,
            );
            if (v)
              v.attributes = {
                ...v.attributes,
                appVersionState: "WAITING_FOR_REVIEW",
                appStoreState: "WAITING_FOR_REVIEW",
              };
          }
      }
      if (attrs.canceled === true)
        s.attributes = { ...s.attributes, state: "CANCELING" };
      return { status: 200, body: { data: s } };
    }
    if (method === "POST" && parts.length === 2 && !BASE_CREATES.has(parts[1]!))
      return this.create(parts[1]!, data as Record<string, unknown>);
    return super.route(method, url, body);
  }
}
