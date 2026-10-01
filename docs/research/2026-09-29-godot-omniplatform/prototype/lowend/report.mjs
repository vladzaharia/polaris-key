// Summarises wrapper results (results/*.json, one per device/runtime) as Markdown tables.
// usage: node report.mjs results/a.json [results/b.json ...]
import fs from "node:fs";
import path from "node:path";
const files = process.argv.slice(2);
const rows = files.map((f) => ({
  name: path.basename(f, ".json"),
  d: JSON.parse(fs.readFileSync(f, "utf8")),
}));
const cell = (s) => (s ? `${s.median} (${s.best})` : "—");
const mb = (t, k) =>
  t?.MBps?.[k] ? `${t.MBps[k].median} (${t.MBps[k].best})` : "—";
const table = (head, body) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
console.log("### Environment\n");
console.log(
  table(
    [
      "run",
      "os",
      "model / cpu",
      "cores",
      "engine",
      "threads",
      "all suites pass",
    ],
    rows.map(({ name, d }) => [
      name,
      `${d.env.os} ${d.env.os_version}`,
      `${d.env.model} / ${d.env.processor}`,
      d.env.cores,
      d.env.engine + (d.env.debug_build ? " debug" : " release"),
      d.env.threads,
      `${d.correctness.summary.all_pass} (sha512 ${d.correctness.sha512}, ed ${d.correctness.ed25519_fast}, sliced ${d.correctness.ed25519_sliced}, jws ${d.correctness.jws_cases}, sigs ${d.correctness.corpus_sigs_fast}, content ${d.correctness.content})`,
    ]),
  ),
);
console.log("\n### Ed25519 verify, ms: median (best)\n");
console.log(
  table(
    [
      "run",
      "small (252 B)",
      "payload at cap (87 KB)",
      "bundle at cap (350 KB)",
      "SHA-512 GDScript MB/s",
    ],
    rows.map(({ name, d }) => [
      name,
      cell(d.timings.ed25519_small),
      cell(d.timings.ed25519_payload87k),
      cell(d.timings.ed25519_bundle350k),
      mb(d.timings, "sha512_gdscript_256KiB"),
    ]),
  ),
);
for (const set of ["timings", "timings_large"]) {
  const rs = rows.filter(({ d }) => d[set]);
  if (!rs.length) continue;
  console.log(
    `\n### Engine throughput and content bench, ${set === "timings" ? "small" : "large"} set, MB/s of output: median (best)\n`,
  );
  console.log(
    table(
      [
        "run",
        "SHA-256 stream",
        "zstd full decode",
        "full apply",
        "chunk sync",
        "delta verified",
        "delta decode only",
        "file rebuild",
        "index parse ms",
        "plan ms",
      ],
      rs.map(({ name, d }) => [
        name,
        mb(d[set], "sha256_engine_stream"),
        mb(d[set], "zstd_decode_full"),
        mb(d[set], "content_full_apply"),
        mb(d[set], "content_chunk_sync"),
        mb(d[set], "content_delta_verified"),
        mb(d[set], "content_delta_engine_decode"),
        mb(d[set], "content_file_rebuild"),
        cell(d[set].parse_chunk_index),
        cell(d[set].plan_real_case),
      ]),
    ),
  );
}
console.log(
  "\n### Frame-time probe: worst frame gap, ms (median of reps); wall ms for the verify\n",
);
const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : undefined;
};
for (const v of ["payload87k", "bundle350k"]) {
  console.log(`\n${v}\n`);
  console.log(
    table(
      [
        "run",
        "idle max / p50",
        "main thread max",
        "WorkerThreadPool max / wall",
        "sliced 4 ms max / wall",
        "sliced 8 ms max / wall",
      ],
      rows
        .filter(({ d }) => d.frame_probe)
        .map(({ name, d }) => {
          const p = d.frame_probe[v];
          const g = (m, k) => med((p[m] || []).map((x) => x[k]));
          const idle = p.idle?.length ? p.idle : d.frame_probe.bundle350k.idle;
          return [
            name,
            `${med(idle.map((x) => x.max_ms))} / ${med(idle.map((x) => x.p50_ms))}`,
            `${g("main", "max_ms")}`,
            `${g("pool", "max_ms")} / ${g("pool", "wall_ms")}`,
            `${g("sliced4", "max_ms")} / ${g("sliced4", "wall_ms")}`,
            `${g("sliced8", "max_ms")} / ${g("sliced8", "wall_ms")}`,
          ];
        }),
    ),
  );
}
