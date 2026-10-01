// S-02 probe Worker: path B of the R2 Range spike (notes/S-02.md).
//
// Serves content-addressed R2 objects the way README §3.5 specifies for `pkey-cdn`:
//   ETag: "<sha256hex>"            strong, equal to the key's hash (never R2's own MD5 ETag)
//   Repr-Digest: sha-256=:<b64>:   RFC 9530, the whole representation even on a 206
//   Accept-Ranges: bytes           one range per request; multi-range is answered with a full 200
//   If-Range                       evaluated here (R2's `onlyIf` supports every conditional but If-Range)
//   If-None-Match                  answered from the key alone, with no R2 read
//   Cache-Control: public, max-age=31536000, immutable
//
// Routes (the object key is everything after the mode prefix):
//   GET|HEAD /b/<key>   binding only: every request is one R2 read, 206 via get(key, { range })
//   GET|HEAD /c/<key>   Cache API: caches.default.match() first; full 200s are put, 206s never are
//   GET|HEAD /r/<key>   R2 pass-through, an emulation of path A's *origin* (what an R2 public
//                       bucket answers before the zone cache): R2's own httpEtag, and Range and
//                       conditionals handed to R2 as Headers, get(key, { range, onlyIf: headers })
//   GET|HEAD /<key>     same as /b/, so a bare key works like path A's URL shape
//   PUT  /_probe/put/<key>                    upload (only when PROBE_PUT_TOKEN is set and matches)
//   POST /_probe/mpu/<key>?op=create|part|complete   multipart upload, for objects over the
//                                                    Worker request-body limit and for R2's
//                                                    multipart ETag format
//   GET  /_probe/info    what this deployment is (mode flags, never secrets)
//   GET  /_probe/seen    the last 100 requests' method and range/conditional/encoding/CORS
//                        headers as this isolate saw them (?reset=1 clears): shows what a client
//                        (browser, Godot, SDK) really sent, and whether a CORS preflight happened
//   OPTIONS *            CORS preflight (Allow-Origin from CORS_ORIGIN, default "*"), so browser
//                        probes can send Range and If-Range cross-origin
//
// Keys must be s02/blobs/sha256/<64 hex> or s02/bundles/sha256/<64 hex>. The s02/ prefix is
// mandatory for reads, put and mpu alike: the Worker can never write into the real blobs/ or
// bundles/ prefixes (which P2-01 puts under a 180-day age lock), and teardown is one prefix
// delete. Uploads are verified against that hash by R2 itself (put's `sha256` option), so the
// ETag this Worker derives from the key is true.
//
// This is spike code, not the production route (P2b-04 owns that). It has no gating.

const KEY_RE = /^s02\/(blobs|bundles)\/sha256\/([0-9a-f]{64})$/;
const IMMUTABLE = "public, max-age=31536000, immutable";
const SEEN = [];
const SEEN_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "accept-encoding",
  "origin",
  "access-control-request-method",
  "access-control-request-headers",
  "user-agent",
];
const EXPOSE =
  "ETag, Repr-Digest, Content-Range, Content-Length, Accept-Ranges, Content-Encoding, X-Probe-Decision, X-Probe-Cache, X-R2-ETag";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!path.startsWith("_probe/")) {
      const h = { method: request.method, path: path.slice(0, 24) };
      for (const k of SEEN_HEADERS)
        if (request.headers.has(k)) h[k] = request.headers.get(k).slice(0, 120);
      SEEN.push(h);
      if (SEEN.length > 100) SEEN.shift();
    }
    try {
      if (path === "_probe/info") return info(env);
      if (path === "_probe/seen") {
        const out = json(200, SEEN.slice());
        if (url.searchParams.get("reset")) SEEN.length = 0;
        return withCors(out, env);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": env.CORS_ORIGIN || "*",
            "Access-Control-Allow-Methods": "GET, HEAD",
            "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match",
            "Access-Control-Max-Age": "600",
          },
        });
      }
      if (path.startsWith("_probe/put/"))
        return await put(request, env, path.slice(11));
      if (path.startsWith("_probe/mpu/"))
        return await mpu(request, env, url, path.slice(11));
      let mode = "b";
      let key = path;
      if (
        path.startsWith("b/") ||
        path.startsWith("c/") ||
        path.startsWith("r/")
      ) {
        mode = path[0];
        key = path.slice(2);
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return text(405, "method not allowed", { Allow: "GET, HEAD" });
      }
      const m = KEY_RE.exec(key);
      if (!m) return text(404, "not a content-addressed key");
      return withCors(
        await serve(request, env, ctx, url, mode, key, m[2]),
        env,
      );
    } catch (err) {
      return text(500, `probe worker error: ${err && err.message}`);
    }
  },
};

function withCors(res, env) {
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", env.CORS_ORIGIN || "*");
  out.headers.set("Access-Control-Expose-Headers", EXPOSE);
  return out;
}

function info(env) {
  return json(200, {
    worker: "pk-r2-probe",
    putEnabled: Boolean(env.PROBE_PUT_TOKEN),
    cacheFillOnRange: env.CACHE_FILL_ON_RANGE !== "0",
    workersCache: env.WORKERS_CACHE === "1",
  });
}

// ---------------------------------------------------------------- serving

async function serve(request, env, ctx, url, mode, key, hex) {
  const t0 = Date.now();
  const etag = `"${hex}"`;
  const base = baseHeaders(hex);
  base.set("X-Probe-Mode", mode);

  // If-None-Match takes precedence over Range (RFC 9110 §13.2.2). The key is the hash, so a match
  // needs no R2 read at all.
  const inm = request.headers.get("If-None-Match");
  if (inm && etagListMatches(inm, etag, /* weak */ true)) {
    base.set("X-Probe-Decision", "304-if-none-match");
    return new Response(null, { status: 304, headers: base });
  }

  // Range, filtered by If-Range. Only a strong, exact match of our ETag keeps the range. A date,
  // a weak tag, R2's own MD5 ETag or any other value drops it, so a resumed download can never
  // splice two representations.
  let rangeHeader = request.headers.get("Range");
  let decision = rangeHeader ? "range" : "full";
  const ifRange = request.headers.get("If-Range");
  if (rangeHeader && ifRange !== null && ifRange.trim() !== etag) {
    rangeHeader = null;
    decision = "if-range-mismatch-full";
  }
  let range = null;
  if (rangeHeader) {
    range = parseRange(rangeHeader);
    if (range === "multi") {
      decision = "multi-range-ignored-full";
      range = null;
    } else if (range === "invalid") {
      decision = "range-unparseable-full";
      range = null;
    }
  }
  base.set("X-Probe-Decision", decision);

  if (mode === "r") return await passThrough(request, env, key, t0);
  if (mode === "c") {
    const res = await serveViaCacheApi(
      request,
      env,
      ctx,
      url,
      key,
      hex,
      range,
      rangeHeader,
      base,
    );
    res.headers.set("Server-Timing", `worker;dur=${Date.now() - t0}`);
    return res;
  }
  const res = await serveFromR2(request, env, key, range, base);
  res.headers.set("Server-Timing", `r2;dur=${Date.now() - t0}`);
  return res;
}

// Path A's origin, emulated: hand the client's Range and conditional headers to R2 unchanged and
// answer with R2's own metadata. If-Range is not evaluated (R2 does not support it, Workers API
// reference "Conditional operations"), which is exactly what this mode exists to show.
async function passThrough(request, env, key, t0) {
  const head = request.method === "HEAD";
  const h = new Headers();
  let obj;
  try {
    obj = head
      ? await env.BUCKET.head(key)
      : await env.BUCKET.get(key, {
          range: request.headers,
          onlyIf: request.headers,
        });
  } catch (err) {
    h.set(
      "X-Probe-R2-Error",
      String((err && err.message) || err).slice(0, 200),
    );
    const meta = await env.BUCKET.head(key);
    if (!meta) return text(404, "no such object");
    h.set("Content-Range", `bytes */${meta.size}`);
    return new Response(null, { status: 416, headers: h });
  }
  if (!obj) return text(404, "no such object");
  obj.writeHttpMetadata(h);
  h.set("ETag", obj.httpEtag);
  h.set("Accept-Ranges", "bytes");
  h.set("X-Probe-Mode", "r");
  h.set("Server-Timing", `r2;dur=${Date.now() - t0}`);
  if (!head && !("body" in obj)) {
    // onlyIf failed: R2 returns the metadata without a body (304 for If-None-Match, 412 otherwise).
    const inm = request.headers.get("If-None-Match");
    return new Response(null, { status: inm ? 304 : 412, headers: h });
  }
  if (head) {
    h.set("Content-Length", String(obj.size));
    return new Response(null, { status: 200, headers: h });
  }
  if (obj.range && request.headers.has("Range")) {
    const r = obj.range;
    const offset =
      "suffix" in r && r.suffix !== undefined
        ? obj.size - r.suffix
        : (r.offset ?? 0);
    const length =
      "suffix" in r && r.suffix !== undefined
        ? r.suffix
        : (r.length ?? obj.size - offset);
    h.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${obj.size}`,
    );
    h.set("Content-Length", String(length));
    h.set("X-Probe-R2-Range", JSON.stringify(r));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers: h });
}

async function serveFromR2(request, env, key, range, base) {
  const head = request.method === "HEAD";
  if (head) {
    const obj = await env.BUCKET.head(key);
    if (!obj) return text(404, "no such object");
    base.set("X-R2-ETag", obj.httpEtag);
    if (range) {
      const r = resolveRange(range, obj.size);
      if (!r) return unsatisfiable(obj.size, base);
      base.set(
        "Content-Range",
        `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`,
      );
      base.set("Content-Length", String(r.length));
      return new Response(null, { status: 206, headers: base });
    }
    base.set("Content-Length", String(obj.size));
    return new Response(null, { status: 200, headers: base });
  }

  if (range) {
    // R2 needs a concrete, in-bounds range; resolve suffix/open ranges against the size first.
    // A suffix range can go straight to R2, and so can offset+length inside the object, but an
    // out-of-bounds start must become a 416, which needs the size. One head() only when needed.
    if (range.suffix === 0) {
      const h = await env.BUCKET.head(key);
      if (!h) return text(404, "no such object");
      return unsatisfiable(h.size, base);
    }
    let r2range;
    if (range.suffix !== undefined) r2range = { suffix: range.suffix };
    else if (range.end === undefined) r2range = { offset: range.start };
    else r2range = { offset: range.start, length: range.end - range.start + 1 };
    let obj;
    try {
      obj = await env.BUCKET.get(key, { range: r2range });
    } catch (err) {
      const h = await env.BUCKET.head(key);
      if (!h) return text(404, "no such object");
      return unsatisfiable(h.size, base);
    }
    if (!obj) return text(404, "no such object");
    base.set("X-R2-ETag", obj.httpEtag);
    const r = resolveRange(range, obj.size);
    if (!r) {
      // R2 answered but the range is past the end (some emulators clamp instead of throwing).
      obj.body?.cancel();
      return unsatisfiable(obj.size, base);
    }
    const got =
      obj.range && "offset" in obj.range
        ? obj.range
        : { offset: r.offset, length: r.length };
    const length = got.length ?? obj.size - got.offset;
    base.set(
      "Content-Range",
      `bytes ${got.offset}-${got.offset + length - 1}/${obj.size}`,
    );
    base.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers: base });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return text(404, "no such object");
  base.set("X-R2-ETag", obj.httpEtag);
  base.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers: base });
}

async function serveViaCacheApi(
  request,
  env,
  ctx,
  url,
  key,
  hex,
  range,
  rangeHeader,
  base,
) {
  const cache = caches.default;
  const canonical = new URL(`/c/${key}`, url.origin).toString();
  const lookup = new Request(canonical, {
    method: "GET",
    headers: rangeHeader && range ? { Range: rangeHeader } : {},
  });
  const hit = await cache.match(lookup);
  if (hit) {
    const out = new Response(request.method === "HEAD" ? null : hit.body, hit);
    out.headers.set("X-Probe-Cache", "hit");
    out.headers.set("X-Probe-Decision", base.get("X-Probe-Decision"));
    return out;
  }
  const res = await serveFromR2(request, env, key, range, new Headers(base));
  res.headers.set("X-Probe-Cache", "miss");
  if (request.method === "HEAD" || (res.status !== 200 && res.status !== 206))
    return res;

  if (res.status === 200) {
    // Tee: one branch to the client, one into the cache. put() of a 200 with Content-Length works;
    // put() of a 206 throws, so partial responses are never stored.
    const [a, b] = res.body.tee();
    const stored = new Response(b, {
      status: 200,
      headers: stripProbe(res.headers),
    });
    ctx.waitUntil(cache.put(new Request(canonical), stored).catch(() => {}));
    return new Response(a, res);
  }
  // A 206 on a miss: serve it, and (unless disabled) fill the full object in the background so
  // the next Range on this colo is a cache hit. That costs one extra full R2 read per colo.
  if (env.CACHE_FILL_ON_RANGE !== "0") {
    ctx.waitUntil(
      (async () => {
        const full = await env.BUCKET.get(key);
        if (!full) return;
        const h = baseHeaders(hex);
        h.set("Content-Length", String(full.size));
        await cache.put(
          new Request(canonical),
          new Response(full.body, { status: 200, headers: h }),
        );
      })().catch(() => {}),
    );
    res.headers.set("X-Probe-Cache", "miss-fill");
  }
  return res;
}

function baseHeaders(hex) {
  const h = new Headers();
  h.set("Content-Type", "application/octet-stream");
  h.set("ETag", `"${hex}"`);
  h.set("Repr-Digest", `sha-256=:${hexToB64(hex)}:`);
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", IMMUTABLE);
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

function stripProbe(headers) {
  const h = new Headers(headers);
  for (const k of ["X-Probe-Cache", "X-Probe-Decision", "Server-Timing"])
    h.delete(k);
  return h;
}

function unsatisfiable(size, base) {
  const h = new Headers(base);
  h.set("Content-Range", `bytes */${size}`);
  h.set("Content-Length", "0");
  return new Response(null, { status: 416, headers: h });
}

// ---------------------------------------------------------------- Range parsing

// Returns {start, end?} | {suffix} | "multi" | "invalid". RFC 9110 §14.1.2 byte ranges.
export function parseRange(value) {
  const m = /^\s*bytes\s*=\s*(.*)$/i.exec(value);
  if (!m) return "invalid";
  const specs = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (specs.length === 0) return "invalid";
  if (specs.length > 1) return "multi";
  const s = specs[0];
  let r = /^(\d+)-(\d*)$/.exec(s);
  if (r) {
    const start = Number(r[1]);
    const end = r[2] === "" ? undefined : Number(r[2]);
    if (
      !Number.isSafeInteger(start) ||
      (end !== undefined && (!Number.isSafeInteger(end) || end < start))
    ) {
      return "invalid";
    }
    return { start, end };
  }
  r = /^-(\d+)$/.exec(s);
  if (r) {
    const suffix = Number(r[1]);
    if (!Number.isSafeInteger(suffix)) return "invalid";
    return { suffix }; // bytes=-0 is valid syntax but unsatisfiable: resolveRange gives a 416
  }
  return "invalid";
}

// Resolve against the size: {offset, length} or null when unsatisfiable.
export function resolveRange(range, size) {
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  if (range.start >= size) return null;
  const end =
    range.end === undefined ? size - 1 : Math.min(range.end, size - 1);
  return { offset: range.start, length: end - range.start + 1 };
}

function etagListMatches(list, etag, weak) {
  if (list.trim() === "*") return true;
  return list.split(",").some((t) => {
    let v = t.trim();
    if (weak && v.startsWith("W/")) v = v.slice(2);
    return v === etag;
  });
}

// ---------------------------------------------------------------- uploads (probe only)

function authorised(request, env) {
  const tok = env.PROBE_PUT_TOKEN;
  return Boolean(tok) && request.headers.get("X-Probe-Token") === tok;
}

async function put(request, env, key) {
  if (request.method !== "PUT") return text(405, "PUT only");
  if (!authorised(request, env)) return text(403, "uploads disabled");
  const m = KEY_RE.exec(key);
  if (!m) return text(400, "key must be s02/(blobs|bundles)/sha256/<hex>");
  const obj = await env.BUCKET.put(key, request.body, {
    sha256: m[2],
    httpMetadata: {
      contentType: "application/octet-stream",
      cacheControl: IMMUTABLE,
    },
  });
  return json(201, {
    key,
    size: obj.size,
    etag: obj.etag,
    httpEtag: obj.httpEtag,
  });
}

async function mpu(request, env, url, key) {
  if (request.method !== "POST") return text(405, "POST only");
  if (!authorised(request, env)) return text(403, "uploads disabled");
  if (!KEY_RE.test(key))
    return text(400, "key must be s02/(blobs|bundles)/sha256/<hex>");
  const op = url.searchParams.get("op");
  if (op === "create") {
    const up = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType: "application/octet-stream",
        cacheControl: IMMUTABLE,
      },
    });
    return json(200, { uploadId: up.uploadId });
  }
  const uploadId = url.searchParams.get("uploadId");
  const up = env.BUCKET.resumeMultipartUpload(key, uploadId);
  if (op === "part") {
    const part = await up.uploadPart(
      Number(url.searchParams.get("n")),
      request.body,
    );
    return json(200, part);
  }
  if (op === "complete") {
    const parts = await request.json();
    const obj = await up.complete(parts);
    return json(200, {
      key,
      size: obj.size,
      etag: obj.etag,
      httpEtag: obj.httpEtag,
    });
  }
  return text(400, "op must be create|part|complete");
}

// ---------------------------------------------------------------- helpers

function hexToB64(hex) {
  let s = "";
  for (let i = 0; i < hex.length; i += 2)
    s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(s);
}

function text(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", ...extra },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
