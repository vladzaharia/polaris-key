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
 *   GET    https://playdeveloperreporting.googleapis.com/v1beta1/apps/<pkg>/<set>
 *   POST   https://playdeveloperreporting.googleapis.com/v1beta1/apps/<pkg>/<set>:query
 *   GET    https://playdeveloperreporting.googleapis.com/v1beta1/apps:search   (A-16) every app
 *          the account may access (`searchApps`; one page)
 *
 * A-18e adds the storefront adapter's surface (`StoreState`, copied into each edit and back on
 * commit): `edits.details` get/patch, `edits.listings` list/get/patch/update, `edits.images`
 * list and the media upload (`/upload/androidpublisher/…`), `edits.tracks.create`,
 * `edits.testers` get/patch, `edits.validate`, `monetization.onetimeproducts` get/patch
 * (`allowMissing`) and `tracks.releases.list`.
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

/** What an edit copies from the live app besides its tracks (A-18e), and writes back on commit. */
export interface StoreState {
  details: Json;
  listings: Map<string, Json>;
  /** `<language>/<imageType>` → images. */
  images: Map<string, Json[]>;
  testers: Map<string, string[]>;
}

const cloneStore = (s: StoreState): StoreState => ({
  details: structuredClone(s.details),
  listings: new Map([...s.listings].map(([k, v]) => [k, structuredClone(v)])),
  images: new Map([...s.images].map(([k, v]) => [k, structuredClone(v)])),
  testers: new Map([...s.testers].map(([k, v]) => [k, [...v]])),
});

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
    { tracks: Map<string, Json>; valid: boolean; store: StoreState }
  >();
  /** The live listing state (A-18e). */
  readonly store: StoreState = {
    details: { defaultLanguage: "en-US", contactEmail: "dev@acme.test" },
    listings: new Map([
      [
        "en-US",
        {
          language: "en-US",
          title: "djdl",
          shortDescription: "Dice, juggled.",
          fullDescription: "A game about dice.",
        },
      ],
    ]),
    images: new Map(),
    testers: new Map(),
  };
  /** One-time products by id (A-18e). */
  readonly oneTimeProducts = new Map<string, Json>();
  /** `tracks.releases.list` answers, by track (A-18e). */
  releaseSummaries = new Map<string, Json[]>();
  /** Uploaded image bodies' sizes, in order (A-18e). */
  readonly uploads: Array<{
    type: string | null;
    size: number;
    sha1: string;
    sha256: string;
  }> = [];
  /** Whether `images.list` reports each image's hashes (Play documents both; A-18e's fallback is
   *  the ledger's own record when it does not). */
  imageHashes = true;
  private nextImage = 1;
  reporting: Record<string, Json>;
  /** What `apps:search` answers (A-16's team listing). Only `PLAY_PACKAGE` is editable. */
  searchApps: Json[] = [
    {
      name: `apps/${PLAY_PACKAGE}`,
      packageName: PLAY_PACKAGE,
      displayName: "djdl",
    },
  ];
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
    const upload = publisher && url.pathname.startsWith("/upload/");
    const prefix = publisher
      ? `${upload ? "/upload" : ""}/androidpublisher/v3/applications/`
      : `/v1beta1/apps/`;
    if (upload && init?.body instanceof Uint8Array) {
      const hex = async (algo: string) =>
        [
          ...new Uint8Array(
            await crypto.subtle.digest(algo, init.body as Uint8Array),
          ),
        ]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      this.uploads.push({
        type: headers.get("content-type"),
        size: init.body.byteLength,
        sha1: await hex("SHA-1"),
        sha256: await hex("SHA-256"),
      });
    }
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
        store: cloneStore(this.store),
      });
      return json(200, { id, expiryTimeSeconds: "1790003600" });
    }
    const extra = this.storefrontRoute(method, path, query, body);
    if (extra) return extra;
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
      if (this.propagate) {
        for (const [k, v] of edit.tracks) this.live.set(k, structuredClone(v));
        const next = cloneStore(edit.store);
        this.store.details = next.details;
        for (const k of ["listings", "images", "testers"] as const) {
          this.store[k].clear();
          for (const [kk, vv] of next[k] as Map<string, never>)
            (this.store[k] as Map<string, unknown>).set(kk, vv);
        }
      }
      this.edits.delete(id);
      return json(200, { id, expiryTimeSeconds: "1790003600" });
    }
    return googleError(404, "Not Found", "notFound");
  }

  /** The A-18e surface (see the file comment); null for a path the P5-03 routes answer. */
  private storefrontRoute(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): Response | null {
    const otp = /^(?:oneTimeProducts|onetimeproducts)\/([^/:]+)$/.exec(path);
    if (otp) {
      const id = decodeURIComponent(otp[1]!);
      const have = this.oneTimeProducts.get(id);
      if (method === "GET")
        return have
          ? json(200, structuredClone(have))
          : googleError(404, "Not found", "notFound");
      if (method === "PATCH") {
        if (!have && query.get("allowMissing") !== "true")
          return googleError(404, "Not found", "notFound");
        if (!query.get("regionsVersion.version"))
          return googleError(400, "regionsVersion required", "invalid");
        const b = (body ?? {}) as Json;
        const next: Json = { ...(have ?? {}), ...b };
        this.oneTimeProducts.set(id, next);
        return json(200, structuredClone(next));
      }
      return null;
    }
    const rel = /^tracks\/([^/]+)\/releases$/.exec(path);
    if (rel && method === "GET")
      return json(200, {
        releases: structuredClone(
          this.releaseSummaries.get(decodeURIComponent(rel[1]!)) ?? [],
        ),
      });
    const e =
      /^edits\/([^/:]+)(?::(validate))?(?:\/(details|listings|testers|tracks)(?:\/([^/]+))?(?:\/([^/]+))?)?$/.exec(
        path,
      );
    if (!e) return null;
    const [, id, custom, kind, a, b] = e as unknown as [
      string,
      string,
      string | undefined,
      string | undefined,
      string | undefined,
      string | undefined,
    ];
    // P5-03's own routes: the bare edit, its commit, tracks get/list/patch.
    if (!custom && (!kind || (kind === "tracks" && !(method === "POST" && !a))))
      return null;
    const edit = this.edits.get(id);
    if (!edit || !edit.valid)
      return googleError(400, "This Edit has been deleted.", "editDeleted");
    const st = edit.store;
    const one = a !== undefined ? decodeURIComponent(a) : undefined;
    const two = b !== undefined ? decodeURIComponent(b) : undefined;
    if (custom === "validate" && method === "POST")
      return json(200, { id, expiryTimeSeconds: "1790003600" });
    if (kind === "details") {
      if (method === "GET") return json(200, structuredClone(st.details));
      if (method === "PATCH") {
        st.details = { ...st.details, ...(body as Json) };
        return json(200, structuredClone(st.details));
      }
    }
    if (kind === "listings") {
      if (one === undefined && method === "GET")
        return json(200, {
          listings: [...st.listings.values()].map((l) => structuredClone(l)),
        });
      if (one !== undefined && two === undefined) {
        const have = st.listings.get(one);
        if (method === "GET")
          return have
            ? json(200, structuredClone(have))
            : googleError(404, "Not found", "notFound");
        if (method === "PATCH" && !have)
          return googleError(404, "Not found", "notFound");
        if (method === "PATCH" || method === "PUT") {
          const next = {
            ...(method === "PATCH" ? have : {}),
            ...(body as Json),
            language: one,
          };
          st.listings.set(one, next);
          return json(200, structuredClone(next));
        }
      }
      if (one !== undefined && two !== undefined) {
        const key = `${one}/${two}`;
        const list = st.images.get(key) ?? [];
        if (method === "GET")
          return json(200, { images: structuredClone(list) });
        if (method === "POST") {
          const last = this.uploads[this.uploads.length - 1];
          const n = this.nextImage++;
          if (!last || last.size > 15 * 1024 * 1024)
            return googleError(400, "Invalid image", "invalid");
          const image = {
            id: `img${n}`,
            url: `https://play-lh.googleusercontent.com/img${n}`,
            ...(this.imageHashes
              ? { sha1: last.sha1, sha256: last.sha256 }
              : {}),
            aiGeneratedState: query.get("aiGeneratedState"),
          };
          st.images.set(key, [...list, image]);
          return json(200, { image });
        }
      }
    }
    if (kind === "testers" && one !== undefined) {
      if (method === "GET")
        return st.testers.has(one)
          ? json(200, { googleGroups: [...st.testers.get(one)!] })
          : json(200, {});
      if (method === "PATCH") {
        const groups = ((body as Json).googleGroups as string[]) ?? [];
        st.testers.set(one, [...groups]);
        return json(200, { googleGroups: [...groups] });
      }
    }
    if (kind === "tracks" && method === "POST" && one === undefined) {
      const bb = body as Json;
      if (bb.type !== "CLOSED_TESTING" || typeof bb.track !== "string")
        return googleError(400, "Invalid track config", "invalid");
      if (edit.tracks.has(bb.track))
        return googleError(409, "Track exists", "alreadyExists");
      const t = { track: bb.track, releases: [] };
      edit.tracks.set(bb.track, t);
      return json(200, structuredClone(t));
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
