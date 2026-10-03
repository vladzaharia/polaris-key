/**
 * A fake Microsoft for the Microsoft Store connector suite (P5-04): the Entra ID v1 token endpoint
 * and the Store submission API, over the documentation-recorded payloads in
 * `test/fixtures/msstore/store.json`. Web APIs only, so it also runs in workerd.
 *
 *   POST https://login.microsoftonline.com/<tenant>/oauth2/token
 *        client_credentials for the one (tenant, client id, client secret) the test stored, with
 *        resource=https://manage.devcenter.microsoft.com; answers `expires_in` as a string, as
 *        the v1 endpoint does
 *   GET  https://manage.devcenter.microsoft.com/v1.0/my/applications/<id>
 *   GET  …/applications/<id>/submissions/<submissionId>
 *   GET  …/applications/<id>/listflights?top=&skip=
 *   GET  …/applications/<id>/flights/<flightId>/submissions/<submissionId>
 *
 * Every API request must carry a bearer token this fake issued and name the one app the Entra
 * app can "see" (another is a 404, as for an app outside the seller account). ANY method other
 * than GET is recorded and answered 405, so a suite can assert the connector never sent one.
 * Knobs: `notReadable` (409 on every read, as for an app with mandatory updates),
 * `failNext(status, n)`, `fail429(n)`. Any other host is recorded in `foreignHost` and refused.
 */

export const STORE_ID = "9NBLGGH4R315";
export const TENANT_ID = "72f988bf-86f1-41af-91ab-2d7cd011db47";
export const CLIENT_ID = "8b1e0f4a-2c3d-4e5f-9a6b-7c8d9e0f1a2b";
export const CLIENT_SECRET = "fixture~client~secret~0123456789";
export const SELLER_ID = "12345678";
const ENTRA_HOST = "login.microsoftonline.com";
const STORE_HOST = "manage.devcenter.microsoft.com";
const RESOURCE = "https://manage.devcenter.microsoft.com";
const PREFIX = "/v1.0/my/applications/";

type Json = Record<string, unknown>;

export interface StoreFixtures {
  token: Json;
  application: Json;
  submissions: Record<string, Json>;
  listflights: { value: Json[]; totalCount: number };
  flightSubmissions: Record<string, Record<string, Json>>;
  pricingVersion2: Json;
  certificationFailed: Json;
}

export interface RecordedRequest {
  method: string;
  /** The path below the app (`""` for the application, `submissions/1`, `listflights`, …). */
  path: string;
  app: string | null;
  query: Record<string, string>;
  authorization: string | null;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export class MsStoreFake {
  readonly requests: RecordedRequest[] = [];
  readonly tokenRequests: Array<{
    tenant: string;
    form: Record<string, string>;
  }> = [];
  readonly foreignHost: string[] = [];
  application: Json;
  readonly submissions = new Map<string, Json>();
  flights: Json[];
  readonly flightSubmissions = new Map<string, Map<string, Json>>();
  notReadable = false;
  /** What the token endpoint answers (the fixture's, with a fresh `access_token`). */
  tokenResponse: Json;
  private readonly tokens = new Set<string>();
  private nextToken = 1;
  private pendingFail: { status: number; n: number } | null = null;
  private pending429 = 0;

  constructor(readonly fixtures: StoreFixtures) {
    this.application = structuredClone(fixtures.application);
    this.tokenResponse = structuredClone(fixtures.token);
    for (const [id, s] of Object.entries(fixtures.submissions))
      this.submissions.set(id, structuredClone(s));
    this.flights = structuredClone(fixtures.listflights.value);
    for (const [fid, subs] of Object.entries(fixtures.flightSubmissions))
      this.flightSubmissions.set(
        fid,
        new Map(Object.entries(structuredClone(subs))),
      );
  }

  failNext(status: number, n = 1): void {
    this.pendingFail = { status, n };
  }

  fail429(n: number): void {
    this.pending429 = n;
  }

  /** Patch one app submission in place (status, statusDetails, packageDeliveryOptions, …). */
  patchSubmission(id: string, patch: Json): void {
    const s = this.submissions.get(id);
    if (!s) throw new Error(`no submission ${id}`);
    Object.assign(s, structuredClone(patch));
  }

  /** Set the rollout of one app submission. */
  setRollout(id: string, rollout: Json): void {
    const s = this.submissions.get(id)!;
    const options = (s.packageDeliveryOptions as Json | undefined) ?? {};
    s.packageDeliveryOptions = { ...options, packageRollout: rollout };
  }

  /** The API requests, as `METHOD path`. */
  calls(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }

  readonly fetchImpl = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.hostname === ENTRA_HOST) return this.token(url, method, init);
    if (url.hostname !== STORE_HOST || url.protocol !== "https:") {
      this.foreignHost.push(url.toString());
      return json(404, { error: "unknown host" });
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    let app: string | null = null;
    let path = url.pathname;
    if (path.startsWith(PREFIX)) {
      const rest = path.slice(PREFIX.length);
      const slash = rest.indexOf("/");
      app = slash < 0 ? rest : rest.slice(0, slash);
      path = slash < 0 ? "" : rest.slice(slash + 1);
    }
    this.requests.push({
      method,
      path: decodeURIComponent(path),
      app,
      query: Object.fromEntries(url.searchParams),
      authorization,
    });
    if (method !== "GET") return json(405, { code: "MethodNotAllowed" });
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;
    if (!token || !this.tokens.has(token))
      return json(401, { code: "Unauthorized" });
    if (app !== STORE_ID) return json(404, { code: "ResourceNotFound" });
    if (this.pending429 > 0) {
      this.pending429--;
      return new Response("{}", {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    if (this.pendingFail && this.pendingFail.n > 0) {
      this.pendingFail.n--;
      return json(this.pendingFail.status, { code: "ServiceError" });
    }
    if (this.notReadable)
      return json(409, {
        code: "InvalidOperation",
        message:
          "The app uses a feature that is not supported by the Microsoft Store submission API.",
      });
    return this.route(path, url.searchParams);
  };

  private route(path: string, query: URLSearchParams): Response {
    if (path === "") return json(200, this.application);
    let m = /^submissions\/([0-9]+)$/.exec(path);
    if (m) {
      const s = this.submissions.get(m[1]!);
      return s ? json(200, s) : json(404, { code: "ResourceNotFound" });
    }
    if (path === "listflights") {
      if (this.flights.length === 0) return json(404, { code: "NotFound" });
      const top = Number(query.get("top") ?? "10");
      const skip = Number(query.get("skip") ?? "0");
      const value = this.flights.slice(skip, skip + top);
      return json(200, {
        value,
        totalCount: this.flights.length,
        ...(skip + top < this.flights.length
          ? {
              "@nextLink": `applications/${STORE_ID}/listflights/?skip=${skip + top}&top=${top}`,
            }
          : {}),
      });
    }
    m = /^flights\/([^/]+)\/submissions\/([0-9]+)$/.exec(path);
    if (m) {
      const s = this.flightSubmissions.get(m[1]!)?.get(m[2]!);
      return s ? json(200, s) : json(404, { code: "ResourceNotFound" });
    }
    return json(404, { code: "ResourceNotFound" });
  }

  private token(url: URL, method: string, init?: RequestInit): Response {
    const tenant = /^\/([^/]+)\/oauth2\/token$/.exec(url.pathname)?.[1] ?? "";
    const form = Object.fromEntries(
      new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    );
    this.tokenRequests.push({ tenant, form });
    if (method !== "POST") return json(405, { error: "invalid_request" });
    if (form.grant_type !== "client_credentials")
      return json(400, { error: "unsupported_grant_type" });
    if (
      tenant !== TENANT_ID ||
      form.client_id !== CLIENT_ID ||
      form.client_secret !== CLIENT_SECRET
    )
      return json(401, { error: "invalid_client" });
    if (form.resource !== RESOURCE)
      return json(400, { error: "invalid_resource" });
    const token = `msst.test-${this.nextToken++}`;
    this.tokens.add(token);
    return json(200, { ...this.tokenResponse, access_token: token });
  }
}
