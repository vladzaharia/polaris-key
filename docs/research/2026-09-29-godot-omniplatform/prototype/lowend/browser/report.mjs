// Summarises browser-matrix results (results/browser-*.json from drive.mjs or the phones' POSTs).
// usage: node report.mjs <file.json>...
import fs from "node:fs";
import path from "node:path";
const rows = process.argv.slice(2).map((f) => ({
  name: path.basename(f, ".json"),
  d: JSON.parse(fs.readFileSync(f, "utf8")),
}));
const t = (h, b) =>
  [
    `| ${h.join(" | ")} |`,
    `| ${h.map(() => "---").join(" | ")} |`,
    ...b.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
const ua = (d) =>
  d.driver
    ? `${d.driver.engine} ${d.driver.version}`
    : (d.userAgent.match(/(Chrome|Version|Firefox)\/[\d.]+/) || [
        d.userAgent,
      ])[0];
const ed = (d, k) => {
  const e = d.ed25519;
  if (!e || !e.available) return e?.error ? "unavailable" : "—";
  const v = e[k];
  if (!v) return "—";
  if (v.skipped) return "skipped (crash)";
  return `${v.verifyMs.median} (${v.verifyMs.best})${v.ok && v.rejectsFlippedSig ? "" : " WRONG"}`;
};
console.log(
  "### WebCrypto Ed25519 verify, ms per verify: median (best), dedicated worker\n",
);
console.log(
  t(
    ["run", "browser", "page Ed25519", "252 B", "87 KB", "350 KB"],
    rows.map(({ name, d }) => [
      name,
      ua(d),
      d.pageEd25519?.available ? "yes" : `no (${d.pageEd25519?.error || "?"})`,
      ed(d, "small"),
      ed(d, "payload87k"),
      ed(d, "bundle350k"),
    ]),
  ),
);
console.log("\n### Content vectors (75 cases) per primitive combo\n");
console.log(
  t(
    ["run", ...Object.keys(rows[0].d.suites)],
    rows.map(({ name, d }) => [
      name,
      ...Object.values(d.suites).map((s) =>
        s.error
          ? "error"
          : `${s.pass}/${s.n}${s.failed?.length ? " failing: " + s.failed.join(", ") : ""}`,
      ),
    ]),
  ),
);
for (const set of ["small", "large"]) {
  const rs = rows.filter(({ d }) => d.bench?.[set] && !d.bench[set].error);
  if (!rs.length) continue;
  console.log(
    `\n### Throughput, ${set} set, MB/s (best of 3; Range: best of 2)\n`,
  );
  console.log(
    t(
      [
        "run",
        "SHA-256 WebCrypto one-shot",
        "SHA-256 hash-wasm",
        "SHA-256 noble",
        "zstd WASM full",
        "full apply",
        "delta apply",
        "chunk sync (memory)",
        "chunk sync (HTTP Range)",
      ],
      rs.map(({ name, d }) => {
        const b = d.bench[set];
        return [
          name,
          b.sha256_webcrypto_oneshot,
          b.sha256_hashwasm_streaming,
          b.sha256_noble_streaming,
          b.zstdDecompress.MBps,
          b.fullApply.outMBps,
          b.deltaApply.outMBps,
          b.chunkReassembly_memory.outMBps,
          `${b.chunkReassembly_httpRange.outMBps} (${b.chunkReassembly_httpRange.runs} requests)`,
        ];
      }),
    ),
  );
}
console.log("\n### Worker capabilities\n");
console.log(
  t(
    [
      "run",
      "OPFS sync handle",
      "OPFS write / read MB/s",
      "quota",
      "DecompressionStream zstd / brotli",
      "Cache.put(206)",
    ],
    rows.map(({ name, d }) => {
      const c = d.workerCaps || {};
      const o = c.opfs || {};
      return [
        name,
        o.syncAccessHandle ? "yes" : `no ${o.error || ""}`,
        o.syncAccessHandle ? `${o.writeMBps} / ${o.readMBps}` : "—",
        c.storage?.quota ? (c.storage.quota / 1e9).toFixed(1) + " GB" : "—",
        `${c.decompressionStream?.zstd} / ${c.decompressionStream?.brotli}`,
        (c.cachePut206 || "").split(":")[0],
      ];
    }),
  ),
);
