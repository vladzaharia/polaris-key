#!/usr/bin/env node
// S-20 reference puller: the guard, fetch, sniff and hash steps that HA-01's `core/safeFetch.ts`
// and `core/hostedAssets.ts` implement in the Worker. Node >= 22, no dependencies.
//
//   node pull.mjs --self-test                     run the URL-guard table
//   node pull.mjs <https-url> [--cap <bytes>] [--sha256 <hex>] [--kind image|file]
//
// It prints one JSON line per pull: the final URL, the redirect hops, status, bytes, sniffed type,
// SHA-256, elapsed ms and the verdict. Nothing is written to disk.

import { createHash } from "node:crypto";

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;
// Hosts the puller never dials: our own zone (a Worker fetch to its own custom domain loops or
// 522s without global_fetch_strictly_public) and names that only resolve privately.
const DENY_SUFFIXES = [
  ".plrs.im",
  ".local",
  ".internal",
  ".localhost",
  ".home.arpa",
];
const DENY_EXACT = new Set(["plrs.im", "localhost"]);

/** The S-20 §6.3 guard. Returns null when the URL may be dialled, else the reason. */
export function guardUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "unparseable";
  }
  if (u.protocol !== "https:") return "scheme";
  if (u.username || u.password) return "credentials";
  if (u.port && u.port !== "443") return "port";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // IP literals: Workers cannot dial them anyway; refusing them here keeps both lanes equal.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("["))
    return "ip-literal";
  if (!host.includes(".")) return "single-label";
  if (DENY_EXACT.has(host) || DENY_SUFFIXES.some((s) => host.endsWith(s)))
    return "denied-host";
  if (raw.length > 2048) return "too-long";
  return null;
}

/** Magic-number sniff. SVG and HTML are never accepted as images. */
export function sniff(b) {
  const h = (i) => b[i];
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4e && h(3) === 0x47)
    return "image/png";
  if (h(0) === 0xff && h(1) === 0xd8 && h(2) === 0xff) return "image/jpeg";
  if (
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (String.fromCharCode(...b.slice(0, 4)) === "GIF8") return "image/gif";
  if (String.fromCharCode(...b.slice(4, 12)).startsWith("ftypavif"))
    return "image/avif";
  if (String.fromCharCode(...b.slice(4, 8)) === "ftyp") return "video/mp4";
  return "application/octet-stream";
}

export async function pull(
  url,
  { cap = 10 * 1024 * 1024, sha256, kind = "image" } = {},
) {
  const t0 = performance.now();
  const hops = [];
  let current = url;
  for (let i = 0; ; i++) {
    const why = guardUrl(current);
    if (why) return { url, hops, verdict: `refused:${why}` };
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "polaris-key-asset-puller/0 (S-20 prototype)" },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (i >= MAX_REDIRECTS)
        return { url, hops, verdict: "refused:redirects" };
      const next = new URL(
        res.headers.get("location") ?? "",
        current,
      ).toString();
      hops.push({ status: res.status, to: new URL(next).host });
      await res.body?.cancel();
      current = next;
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return { url, hops, status: res.status, verdict: "refused:status" };
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (declared > cap) {
      await res.body?.cancel();
      return { url, hops, declared, verdict: "refused:too-large" };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    let head = new Uint8Array(0);
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > cap)
        return { url, hops, bytes, verdict: "refused:too-large" };
      if (head.length < 16)
        head = new Uint8Array([...head, ...chunk.slice(0, 16 - head.length)]);
      hash.update(chunk);
    }
    const digest = hash.digest("hex");
    const type = sniff(head);
    let verdict = "ok";
    if (sha256 && sha256.toLowerCase() !== digest) verdict = "refused:sha256";
    else if (kind === "image" && !type.startsWith("image/"))
      verdict = "refused:not-an-image";
    return {
      url,
      final: new URL(current).host,
      hops,
      status: 200,
      declaredType: res.headers.get("content-type"),
      sniffedType: type,
      bytes,
      sha256: digest,
      ms: Math.round(performance.now() - t0),
      verdict,
    };
  }
}

const SELF_TEST = [
  ["https://raw.githubusercontent.com/o/r/abc/icon.png", null],
  ["https://cdn.example.com/a.png", null],
  ["http://cdn.example.com/a.png", "scheme"],
  ["https://user:pw@cdn.example.com/a.png", "credentials"],
  ["https://cdn.example.com:8443/a.png", "port"],
  ["https://10.0.0.1/a.png", "ip-literal"],
  ["https://[::1]/a.png", "ip-literal"],
  ["https://intranet/a.png", "single-label"],
  ["https://key.plrs.im/admin", "denied-host"],
  ["https://dl.plrs.im/x", "denied-host"],
  ["https://printer.local/a.png", "denied-host"],
  ["ftp://cdn.example.com/a.png", "scheme"],
];

const args = process.argv.slice(2);
if (args[0] === "--self-test") {
  let fail = 0;
  for (const [u, want] of SELF_TEST) {
    const got = guardUrl(u);
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"} ${u} -> ${got ?? "allowed"}`);
  }
  process.exit(fail ? 1 : 0);
} else if (args[0]) {
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const r = await pull(args[0], {
    cap: opt("--cap") ? Number(opt("--cap")) : undefined,
    sha256: opt("--sha256"),
    kind: opt("--kind") ?? "image",
  });
  console.log(JSON.stringify(r));
} else {
  console.error(
    "usage: node pull.mjs --self-test | <https-url> [--cap n] [--sha256 hex] [--kind image|file]",
  );
  process.exit(2);
}
