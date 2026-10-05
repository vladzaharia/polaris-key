/**
 * A fake Google for the Play connector suites (P5-03): the OAuth token endpoint, the Android
 * Publisher edits API and the Play Developer Reporting API, over the recorded-shape payloads in
 * `test/fixtures/play/`. Web APIs only (WebCrypto, `Request`/`Response`), so the same fake runs
 * in the Node lane and in workerd.
 *
 *   POST https://oauth2.googleapis.com/token
 *        verifies the RS256 JWT-bearer assertion against the test key's public half (iss, aud,
 *        scope, iat/exp) and issues a token bound to the requested scope
 *   POST   …/applications/<pkg>/edits                         edits.insert (invalidates every
 *                                                             other open edit: one per user)
 *   GET    …/applications/<pkg>/edits/<id>/tracks              edits.tracks.list
 *   GET    …/applications/<pkg>/edits/<id>/tracks/<track>      edits.tracks.get
 *   PATCH  …/applications/<pkg>/edits/<id>/tracks/<track>      edits.tracks.patch
 *   POST   …/applications/<pkg>/edits/<id>:commit              edits.commit (applies the edit
 *                                                             to the live state unless
 *                                                             `propagate` is off)
 *   DELETE …/applications/<pkg>/edits/<id>                     edits.delete
 *   GET    …/applications/<pkg>/edits/<id>/details             edits.details.get (A-18c)
 *   GET    …/applications/<pkg>/edits/<id>/listings            edits.listings.list (A-18c)
 *   GET    …/applications/<pkg>/edits/<id>/listings/<lang>/<imageType>
 *                                                             edits.images.list (A-18c)
 *   GET    https://playdeveloperreporting.googleapis.com/v1beta1/apps/<pkg>/<set>
 *   POST   https://playdeveloperreporting.googleapis.com/v1beta1/apps/<pkg>/<set>:query
 *   GET    https://playdeveloperreporting.googleapis.com/v1beta1/apps:search   (A-16) every app
 *          the account may access (`searchApps`; one page)
 *
 * Every API call must carry a bearer token this fake issued FOR THAT API's scope (a publisher
 * token on the Reporting API is a 403), and must name the one package the service account is
 * "invited" to (another package is a 403). Knobs: `fail429(n)`, `invalidateOnNextList()` (a
 * Console change lands while the poller's edit is open), `propagate = false` (a commit Play has
 * not propagated yet), `inReview = true` (commit refuses under ERROR_IF_IN_REVIEW). Any other
 * host is recorded in `foreignHost` and refused.
 */

export const PLAY_PACKAGE = "gg.acme.djdl";
export const TOKEN_URI = "https://oauth2.googleapis.com/token";
const PUBLISHER_HOST = "androidpublisher.googleapis.com";
const REPORTING_HOST = "playdeveloperreporting.googleapis.com";
const PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const REPORTING_SCOPE =
  "https://www.googleapis.com/auth/playdeveloperreporting";

export interface PlayFixtures {
  publisher: Record<string, unknown>;
  reporting: Record<string, unknown>;
}

export interface RecordedRequest {
  method: string;
  host: string;
  /** The path below the app (`edits/1/tracks`, `crashRateMetricSet:query`), or the full path. */
  path: string;
  /** The package the request named (`null`: none), checked against the one app it may see. */
  app: string | null;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

type Json = Record<string, unknown>;

const json = (status: number, body: unknown): Response =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const googleError = (status: number, message: string, reason: string) =>
  json(status, {
    error: { code: status, message, errors: [{ reason, message }] },
  });

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Import an SPKI PEM public key for RS256 verification. */
export async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const der = pem
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return crypto.subtle.importKey(
    "spki",
    b64urlDecode(der.replace(/\+/g, "-").replace(/\//g, "_")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export class PlayFake {
  readonly requests: RecordedRequest[] = [];
  readonly tokenRequests: Array<{ iss: string; scope: string }> = [];
  readonly foreignHost: string[] = [];
  /** The app's live state, by track id. */
  readonly live = new Map<string, Json>();
  /** Releases a track had before its last commit (for asserting what a PATCH changed). */
  readonly edits = new Map<
    string,
    { tracks: Map<string, Json>; valid: boolean }
  >();
  reporting: Record<string, Json>;
  /** What `apps:search` answers (A-16's team listing). Only `PLAY_PACKAGE` is editable. */
  searchApps: Json[] = [
    {
      name: `apps/${PLAY_PACKAGE}`,
      packageName: PLAY_PACKAGE,
      displayName: "djdl",
    },
  ];
  /** The store listing the edits API answers (A-18c's import reads it; nothing writes it). */
  details: Json = {
    defaultLanguage: "en-US",
    contactWebsite: "https://djdl.example",
    contactEmail: "support@djdl.example",
  };
  listings: Json[] = [];
  /** `<language>/<imageType>` → the images `edits.images.list` answers. */
  images: Record<string, Json[]> = {};
  /** When false, a commit succeeds but the live state does not change yet. */
  propagate = true;
  /** When true, a commit answers 400 (a change is in review; ERROR_IF_IN_REVIEW). */
  inReview = false;
  private readonly tokens = new Map<string, string>();
  private nextEdit = 17781293802398422551n;
  private nextToken = 1;
  private pending429 = 0;
  private invalidateNextList = false;

  constructor(
    fixtures: PlayFixtures,
    private readonly publicKey: CryptoKey,
    private readonly clientEmail: string,
  ) {
    const list = fixtures.publisher["edits.tracks.list"] as {
      tracks: Json[];
    };
    for (const t of list.tracks)
      this.live.set(t.track as string, structuredClone(t));
    this.reporting = structuredClone(fixtures.reporting) as Record<
      string,
      Json
    >;
  }

  fail429(n: number): void {
    this.pending429 = n;
  }

  invalidateOnNextList(): void {
    this.invalidateNextList = true;
  }

  /** Replace one live track's releases. */
  setTrack(track: string, releases: Json[]): void {
    this.live.set(track, { track, releases: structuredClone(releases) });
  }

  track(track: string): Json[] {
    return structuredClone(
      (this.live.get(track)?.releases as Json[] | undefined) ?? [],
    );
  }

  /** The API requests (not token exchanges), as `METHOD path`. */
  calls(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }

  openEdits(): string[] {
    return [...this.edits.entries()]
      .filter(([, e]) => e.valid)
      .map(([id]) => id);
  }

  readonly fetchImpl = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.toString() === TOKEN_URI && method === "POST")
      return this.token(init);
    if (url.hostname !== PUBLISHER_HOST && url.hostname !== REPORTING_HOST) {
      this.foreignHost.push(url.toString());
      return googleError(404, "unknown host", "notFound");
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;

    const publisher = url.hostname === PUBLISHER_HOST;
    const prefix = publisher
      ? `/androidpublisher/v3/applications/`
      : `/v1beta1/apps/`;
    let path = url.pathname;
    let pkg: string | null = null;
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      pkg = slash < 0 ? rest : rest.slice(0, slash);
      path = slash < 0 ? "" : rest.slice(slash + 1);
    }
    this.requests.push({
      method,
      host: url.hostname,
      path: decodeURIComponent(path),
      app: pkg,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization,
    });

    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : null;
    const scope = token ? this.tokens.get(token) : undefined;
    if (!scope) return googleError(401, "Invalid Credentials", "authError");
    if (scope !== (publisher ? PUBLISHER_SCOPE : REPORTING_SCOPE))
      return googleError(
        403,
        "Request had insufficient authentication scopes.",
        "forbidden",
      );
    if (
      !publisher &&
      method === "GET" &&
      url.pathname === "/v1beta1/apps:search"
    )
      return json(200, { apps: structuredClone(this.searchApps) });
    if (pkg !== PLAY_PACKAGE)
      return googleError(
        403,
        "The caller does not have permission",
        "permissionDenied",
      );
    if (this.pending429 > 0) {
      this.pending429--;
      return new Response(
        JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }),
        { status: 429, headers: { "Retry-After": "0" } },
      );
    }
    return publisher
      ? this.publisherRoute(method, path, url.searchParams, body)
      : this.reportingRoute(method, path, body);
  };

  private async token(init?: RequestInit): Promise<Response> {
    const form = new URLSearchParams(
      typeof init?.body === "string" ? init.body : "",
    );
    if (
      form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
    )
      return json(400, { error: "unsupported_grant_type" });
    const assertion = form.get("assertion") ?? "";
    const [h, p, s] = assertion.split(".");
    if (!h || !p || !s) return json(400, { error: "invalid_grant" });
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      this.publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return json(400, { error: "invalid_grant" });
    const header = JSON.parse(
      new TextDecoder().decode(b64urlDecode(h)),
    ) as Json;
    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(p)),
    ) as Json;
    if (
      header.alg !== "RS256" ||
      claims.iss !== this.clientEmail ||
      claims.aud !== TOKEN_URI ||
      typeof claims.scope !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      (claims.exp as number) - (claims.iat as number) > 3600
    )
      return json(400, { error: "invalid_grant" });
    const scope = claims.scope as string;
    this.tokenRequests.push({ iss: claims.iss as string, scope });
    const token = `ya29.test-${this.nextToken++}`;
    this.tokens.set(token, scope);
    return json(200, {
      access_token: token,
      expires_in: 3599,
      token_type: "Bearer",
    });
  }

  private publisherRoute(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Response {
    if (method === "POST" && path === "edits") {
      for (const e of this.edits.values()) e.valid = false;
      const id = String(this.nextEdit++);
      this.edits.set(id, {
        tracks: new Map(
          [...this.live.entries()].map(([k, v]) => [k, structuredClone(v)]),
        ),
        valid: true,
      });
      return json(200, { id, expiryTimeSeconds: "1790003600" });
    }
    const listing =
      /^edits\/([^/:]+)\/(details|listings)(?:\/([^/]+)\/([^/]+))?$/.exec(path);
    if (listing) {
      const e = this.edits.get(listing[1]!);
      if (!e || !e.valid)
        return googleError(400, "This Edit has been deleted.", "editDeleted");
      if (method !== "GET") return googleError(405, "read only", "notAllowed");
      if (listing[2] === "details")
        return json(200, structuredClone(this.details));
      if (listing[3] === undefined)
        return json(200, {
          kind: "androidpublisher#listingsListResponse",
          listings: structuredClone(this.listings),
        });
      return json(200, {
        images: structuredClone(
          this.images[`${decodeURIComponent(listing[3])}/${listing[4]}`] ?? [],
        ),
      });
    }
    const m = /^edits\/([^/:]+)(:commit)?(?:\/tracks(?:\/(.+))?)?$/.exec(path);
    if (!m) return googleError(404, "Not Found", "notFound");
    const id = m[1]!;
    const edit = this.edits.get(id);
    const tracksPath = path.startsWith(`edits/${id}/tracks`);
    const trackId = m[3] !== undefined ? decodeURIComponent(m[3]) : null;

    if (method === "DELETE" && !tracksPath && !m[2]) {
      if (!edit) return googleError(404, "Edit not found", "editNotFound");
      this.edits.delete(id);
      return new Response(null, { status: 204 });
    }
    if (!edit || !edit.valid)
      return googleError(400, "This Edit has been deleted.", "editDeleted");

    if (method === "GET" && tracksPath && trackId === null) {
      if (this.invalidateNextList) {
        this.invalidateNextList = false;
        edit.valid = false;
        return googleError(400, "This Edit has been deleted.", "editDeleted");
      }
      return json(200, {
        kind: "androidpublisher#tracksListResponse",
        tracks: [...edit.tracks.values()].map((t) => structuredClone(t)),
      });
    }
    if (method === "GET" && trackId !== null) {
      const t = edit.tracks.get(trackId);
      return t
        ? json(200, structuredClone(t))
        : googleError(404, "Track not found", "notFound");
    }
    if (method === "PATCH" && trackId !== null) {
      if (!edit.tracks.has(trackId))
        return googleError(404, "Track not found", "notFound");
      const b = body as Json | null;
      if (!b || b.track !== trackId || !Array.isArray(b.releases))
        return googleError(400, "Invalid track", "invalid");
      edit.tracks.set(trackId, structuredClone(b));
      return json(200, structuredClone(b));
    }
    if (method === "POST" && m[2] === ":commit" && !tracksPath) {
      if (query.get("changesInReviewBehavior") !== "ERROR_IF_IN_REVIEW")
        return googleError(
          400,
          "unexpected changesInReviewBehavior",
          "invalid",
        );
      if (this.inReview)
        return googleError(400, "Changes are in review", "changesInReview");
      if (this.propagate)
        for (const [k, v] of edit.tracks) this.live.set(k, structuredClone(v));
      this.edits.delete(id);
      return json(200, { id, expiryTimeSeconds: "1790003600" });
    }
    return googleError(404, "Not Found", "notFound");
  }

  private reportingRoute(
    method: string,
    path: string,
    body: unknown,
  ): Response {
    const m = /^(crashRateMetricSet|anrRateMetricSet)(:query)?$/.exec(path);
    if (!m) return googleError(404, "Not Found", "notFound");
    const set = m[1]!;
    if (method === "GET" && !m[2])
      return json(200, this.reporting[`${set}.get`] ?? {});
    if (method === "POST" && m[2]) {
      const b = body as Json | null;
      const spec = b?.timelineSpec as Json | undefined;
      if (
        spec?.aggregationPeriod !== "HOURLY" ||
        !Array.isArray(b?.dimensions) ||
        !Array.isArray(b?.metrics)
      )
        return googleError(400, "invalid query", "invalid");
      return json(200, this.reporting[`${set}.query`] ?? { rows: [] });
    }
    return googleError(404, "Not Found", "notFound");
  }
}
