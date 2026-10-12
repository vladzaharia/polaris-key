/**
 * The `pkey dev` HTTP shell. It listens on loopback only, hands every Polaris Key request to the
 * real router (`world.handle`), serves the fake IdP under `/__idp/` and the control surface under
 * `/__dev/`. This file and the rest of `packages/worker/dev/` are bundled into the CLI by
 * `packages/cli/scripts/bundle-dev.mjs`; nothing under `src/` imports them, and a CLI test holds
 * the production Worker bundle free of every one of these strings.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ManifestDocumentName } from "@polaris-key/manifest";
import { createIdp } from "./idp.js";
import { createWorld, KEY_STATES, type World } from "./world.js";

export interface DevServerOptions {
  /** Default 8787; 0 picks a free port. */
  port?: number;
  /** `.pkey/` documents as text; absent: the built-in Tidewater product. */
  manifest?: Partial<Record<ManifestDocumentName, string>>;
  /** Approve every sign-in without showing the page. */
  autoApprove?: boolean;
  /** One line per request. */
  log?: (line: string) => void;
}

export interface DevServer {
  url: string;
  world: World;
  /** Hosts a request tried to reach outside loopback; each was refused. */
  blocked: string[];
  close(): Promise<void>;
}

/** The facts `polaris-key.json` carries, and `pkey dev keys` prints. */
export interface DevInfo {
  baseUrl: string;
  product: string;
  name: string;
  services: string[];
  trust: { pinnedKeys: Record<string, string> };
  releaseKeys: Record<string, string>;
  webOrigins: string[];
  keys: Record<string, string>;
  idp: { issuer: string | null; person: { name: string; email: string } };
  releases: Array<{ version: string; channel: string }>;
  notes: string[];
}

export function infoOf(world: World): DevInfo {
  return {
    baseUrl: world.baseUrl,
    product: world.product,
    name: world.name,
    services: world.services,
    trust: { pinnedKeys: world.trust },
    releaseKeys: world.releaseKeys,
    webOrigins: world.webOrigins,
    keys: { ...world.keys },
    idp: {
      issuer: world.idp.issuer,
      person: { name: world.idp.person.name, email: world.idp.person.email },
    },
    releases: world.releases(),
    notes: world.notes,
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function hostOf(host: string): string {
  return new URL(`http://${host}`).hostname;
}

type IdpHandler = (req: Request, u: URL, path: string) => Promise<Response>;

interface FetchScope {
  blocked: string[];
  handleIdp?: IdpHandler;
  idpHost?: string;
}

const FETCH_SCOPE = new AsyncLocalStorage<FetchScope>();
const ACTIVE_FETCH_SCOPES = new Set<FetchScope>();
let originalFetch: typeof fetch | undefined;
let guardedFetch: typeof fetch | undefined;
/**
 * Install one process-wide guard for every live dev server. A scope selects the right fake IdP
 * while its Worker request is running; outside a request, the guard still refuses egress and
 * records it on every live server. The final release restores precisely the fetch it replaced.
 */
function acquireFetchGuard(scope: FetchScope): () => void {
  if (!guardedFetch) {
    const upstream = globalThis.fetch;
    originalFetch = upstream;
    guardedFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      if (ACTIVE_FETCH_SCOPES.size === 0) return upstream(input, init);
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      let host = "";
      try {
        host = new URL(raw).hostname;
      } catch {
        host = raw;
      }
      const current = FETCH_SCOPE.getStore();
      const idp =
        current?.idpHost === host
          ? current.handleIdp
          : !current
            ? [...ACTIVE_FETCH_SCOPES].find(
                (candidate) => candidate.idpHost === host,
              )?.handleIdp
            : undefined;
      if (idp) {
        const u = new URL(raw);
        return idp(new Request(raw, init), u, u.pathname);
      }
      if (!LOOPBACK.has(host)) {
        for (const target of current ? [current] : ACTIVE_FETCH_SCOPES)
          target.blocked.push(host);
        throw new TypeError(`pkey dev does not contact ${host}`);
      }
      return upstream(input, init);
    }) as typeof fetch;
    globalThis.fetch = guardedFetch;
  }
  ACTIVE_FETCH_SCOPES.add(scope);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ACTIVE_FETCH_SCOPES.delete(scope);
    if (ACTIVE_FETCH_SCOPES.size > 0) return;
    const installed = guardedFetch;
    if (installed && originalFetch && globalThis.fetch === installed)
      globalThis.fetch = originalFetch;
    originalFetch = undefined;
    guardedFetch = undefined;
  };
}

async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(
  res: ServerResponse,
  r: Response,
  body: Buffer,
  origin: string,
  idpOrigin: string | null,
): void {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  // A browser sent to this server's fake IdP https name lands on its loopback page instead.
  const to = headers.location;
  if (idpOrigin && typeof to === "string" && to.startsWith(`${idpOrigin}/`))
    headers.location = `${origin}/__idp${to.slice(idpOrigin.length)}`;
  const cookies =
    (
      r.headers as unknown as { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers).end(body);
}

export async function startDevServer(
  opts: DevServerOptions = {},
): Promise<DevServer> {
  const log = opts.log ?? (() => {});
  const blocked: string[] = [];
  const scope: FetchScope = { blocked };
  const releaseFetch = acquireFetchGuard(scope);
  let handleIdp: IdpHandler | undefined;

  let world: World | undefined;
  let ready: Promise<World>;
  let offline = false;
  let url = "";

  const server: Server = createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const done = (status: number) =>
      log(
        `${new Date().toTimeString().slice(0, 8)} ${req.method} ${path} -> ${status} ${Date.now() - started}ms`,
      );
    try {
      // DNS-rebinding guard: only a loopback Host reaches anything.
      let hostOk = false;
      try {
        hostOk = LOOPBACK.has(hostOf(req.headers.host ?? ""));
      } catch {
        hostOk = false;
      }
      if (!hostOk) {
        res.writeHead(421).end("pkey dev answers on loopback only\n");
        return done(421);
      }
      const w = await ready;
      const isDev = path.startsWith("/__dev/");
      if (offline && !isDev) {
        req.socket.destroy();
        return done(0);
      }
      const body = await bodyOf(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      const request = new Request(new URL(req.url ?? "/", url), {
        method: req.method,
        headers,
        ...(body.length && req.method !== "GET" && req.method !== "HEAD"
          ? { body }
          : {}),
      });
      const target = new URL(request.url);

      if (isDev) {
        const out = await control(w, request, target, {
          setOffline: (v) => {
            offline = v;
          },
          offline: () => offline,
        });
        send(res, out, Buffer.from(await out.arrayBuffer()), url, w.idp.issuer);
        return done(out.status);
      }
      const r =
        path.startsWith("/__idp/") && handleIdp
          ? await handleIdp(request, target, path.slice("/__idp".length))
          : await FETCH_SCOPE.run(scope, () => w.handle(request));
      send(res, r, Buffer.from(await r.arrayBuffer()), url, w.idp.issuer);
      done(r.status);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`${(e as Error).message}\n`);
      log(`error ${req.method} ${path}: ${(e as Error).stack ?? e}`);
      done(500);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 8787, "127.0.0.1", () => resolve());
    });
  } catch (e) {
    releaseFetch();
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}`;
  const idpOrigin = `https://pkey-dev-idp-${randomUUID().replace(/-/g, "")}.test`;

  ready = FETCH_SCOPE.run(scope, () =>
    createWorld({
      baseUrl: url,
      idpOrigin,
      ...(opts.manifest ? { manifest: opts.manifest } : {}),
    }).then((w) => {
      world = w;
      handleIdp = createIdp(w.idp, { autoApprove: opts.autoApprove === true });
      scope.handleIdp = handleIdp;
      scope.idpHost = w.idp.issuer ? new URL(w.idp.issuer).hostname : undefined;
      return w;
    }),
  );
  try {
    await ready;
  } catch (e) {
    server.close();
    releaseFetch();
    throw e;
  }

  let closePromise: Promise<void> | undefined;
  return {
    url,
    world: world!,
    blocked,
    close() {
      closePromise ??= (async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })().finally(releaseFetch);
      return closePromise;
    },
  };
}

interface ControlHooks {
  setOffline(v: boolean): void;
  offline(): boolean;
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

/**
 * `/__dev/*`: GET info; POST commands. A POST needs `X-PKey-Dev`, a header a web page cannot add
 * to a cross-origin request without a preflight this server never answers.
 */
async function control(
  world: World,
  req: Request,
  url: URL,
  hooks: ControlHooks,
): Promise<Response> {
  const cmd = url.pathname.slice("/__dev/".length);
  if (req.method === "GET" && cmd === "info")
    return jsonRes({ ...infoOf(world), offline: hooks.offline() });
  if (req.method !== "POST")
    return jsonRes({ error: "method_not_allowed" }, 405);
  if (!req.headers.get("x-pkey-dev"))
    return jsonRes({ error: "missing_x_pkey_dev" }, 403);
  let args: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) args = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return jsonRes({ error: "invalid_json" }, 400);
  }
  const str = (k: string): string | undefined =>
    typeof args[k] === "string" ? (args[k] as string) : undefined;
  try {
    let message: string;
    switch (cmd) {
      case "expire":
      case "disable":
      case "revoke":
      case "restore":
      case "fill-seats": {
        const key = str("key");
        if (!key) throw new Error(`Name a test key: ${KEY_STATES.join(", ")}.`);
        message = await (cmd === "fill-seats"
          ? world.fillSeats(key)
          : world[cmd](key));
        break;
      }
      case "config": {
        const key = str("name");
        if (!key || !("value" in args))
          throw new Error("Give a config key and a JSON value.");
        message = await world.setConfig(key, args.value, str("key"));
        break;
      }
      case "release": {
        const version = str("version");
        if (!version) throw new Error("Give a version.");
        message = await world.publishRelease(
          version,
          str("channel") ?? "stable",
        );
        break;
      }
      case "offline":
        hooks.setOffline(true);
        message = "offline: requests are dropped until `pkey dev online`";
        break;
      case "online":
        hooks.setOffline(false);
        message = "online";
        break;
      default:
        return jsonRes({ error: "unknown_command", command: cmd }, 404);
    }
    return jsonRes({ ok: true, message });
  } catch (e) {
    return jsonRes({ ok: false, message: (e as Error).message }, 400);
  }
}
