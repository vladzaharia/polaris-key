/**
 * tools/ci-measure.sh: runs a command, passes its exit status and output through, and reports wall
 * time, CPU and peak memory (to the log and the job summary). `/usr/bin/time` is replaced by stubs
 * that write the numbers each flavour (GNU, BSD) writes, so the parsing is checked on any host.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "ci-measure.sh");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A fake time binary: GNU (-f FORMAT -o FILE), BSD (-l -o FILE), or none. */
function timeStub(dir: string, flavor: "gnu" | "bsd" | "none"): string {
  const file = join(dir, `time-${flavor}`);
  if (flavor === "none") return file;
  const gnu = `#!/bin/sh
[ "$1" = "-f" ] || exit 1
fmt="$2"; out="$4"; shift 4
"$@"; st=$?
if [ "$fmt" = "%e" ]; then echo 0 > "$out"; else echo "12.5 20.25 1.75 460800" > "$out"; fi
exit $st
`;
  const bsd = `#!/bin/sh
[ "$1" = "-l" ] || exit 1
out="$3"; shift 3
"$@"; st=$?
printf '       12.50 real        20.25 user         1.75 sys\\n   482344960  maximum resident set size\\n' > "$out"
exit $st
`;
  fs.writeFileSync(file, flavor === "gnu" ? gnu : bsd);
  fs.chmodSync(file, 0o755);
  return file;
}

function measure(
  flavor: "gnu" | "bsd" | "none",
  args: string[],
  env: Record<string, string> = {},
) {
  const dir = fs.mkdtempSync(join(tmpdir(), "cimeasure-"));
  dirs.push(dir);
  const summary = join(dir, "summary.md");
  const run = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      TMPDIR: dir,
      CI_MEASURE_TIME: timeStub(dir, flavor),
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: dir,
      GITHUB_JOB: "j",
      GITHUB_RUN_ID: "1",
      ...env,
    },
  });
  return {
    status: run.status,
    out: run.stdout,
    err: run.stderr,
    summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
  };
}

describe("tools/ci-measure.sh", () => {
  it("reads GNU time: wall, cpu = user + sys, peak rss in MB", () => {
    const r = measure("gnu", ["worker tests", "echo", "hello"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("hello");
    expect(r.out).toContain(
      "ci-measure: worker tests: wall 12.5 s, cpu 22.0 s (user 20.25 + sys 1.75), peak rss 450 MB",
    );
  });

  it("reads BSD time (macOS): the rss is in bytes", () => {
    const r = measure("bsd", ["swift tests", "true"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      "ci-measure: swift tests: wall 12.50 s, cpu 22.0 s (user 20.25 + sys 1.75), peak rss 460 MB",
    );
  });

  it("reports only the wall time when no time binary works", () => {
    const r = measure("none", ["plain", "true"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/ci-measure: plain: wall \d+ s \(cpu and memory not/);
  });

  it.each(["gnu", "bsd", "none"] as const)(
    "passes the command's exit status through (%s) and reports the failed run",
    (flavor) => {
      const r = measure(flavor, ["fails", "sh", "-c", "echo out; exit 7"]);
      expect(r.status).toBe(7);
      expect(r.out).toContain("out");
      expect(r.out).toContain(", exit 7");
    },
  );

  it("appends one heading and one line per step to the job summary", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "cimeasure2-"));
    dirs.push(dir);
    const summary = join(dir, "summary.md");
    const env = {
      PATH: process.env.PATH ?? "",
      TMPDIR: dir,
      CI_MEASURE_TIME: timeStub(dir, "gnu"),
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: dir,
      GITHUB_JOB: "j",
      GITHUB_RUN_ID: "1",
    };
    for (const label of ["first", "second"])
      spawnSync("bash", [SCRIPT, label, "true"], { env });
    const text = fs.readFileSync(summary, "utf8");
    expect(text.match(/^### Step cost/gm)).toHaveLength(1);
    expect(text).toContain("- `first`: wall 12.5 s");
    expect(text).toContain("- `second`: wall 12.5 s");
  });

  it("does not need a job summary", () => {
    const r = measure("gnu", ["no summary", "true"], {
      GITHUB_STEP_SUMMARY: "",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("ci-measure: no summary:");
  });

  it("refuses a call without a command", () => {
    const r = measure("gnu", ["only-a-label"]);
    expect(r.status).toBe(2);
    expect(r.err).toContain("usage:");
  });
});
