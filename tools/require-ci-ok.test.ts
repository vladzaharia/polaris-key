/**
 * tools/require-ci-ok.sh: the gate deploy.yml (verify) and publish-sdks.yml (version) share. It
 * must pass only on a successful "CI OK" check run that belongs to a push run of ci.yml on the
 * exact SHA, and fail closed on everything else. `gh` is replaced by a stub that serves JSON
 * fixtures through the real `jq` with the script's own --jq program, so the filters run too.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "tools", "require-ci-ok.sh");
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface RunRow {
  id: number;
  status: string;
  head_sha?: string;
  path?: string;
  event?: string;
}
interface CheckRow {
  id: number;
  name?: string;
  status: string;
  conclusion: string | null;
  app?: string;
  run: number;
}
interface Fixture {
  runs: RunRow[];
  checks: CheckRow[];
  /** Fail the named API call (exit 1 with an error body on stdout, as gh does). */
  fail?: "runs" | "checks";
}

/** Run the gate against a fixture; `then` replaces the fixture after the first polls. */
function gate(fx: Fixture, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ciok-"));
  dirs.push(dir);
  const body = (f: Fixture) =>
    JSON.stringify({
      workflow_runs: f.runs.map((r) => ({
        head_sha: SHA,
        path: ".github/workflows/ci.yml",
        event: "push",
        ...r,
      })),
      check_runs: f.checks.map((c) => ({
        name: "CI OK",
        app: { slug: c.app ?? "github-actions" },
        html_url: `https://github.com/o/r/actions/runs/${c.run}/job/${c.id}`,
        id: c.id,
        status: c.status,
        conclusion: c.conclusion,
      })),
    });
  writeFileSync(join(dir, "fixture.json"), body(fx));
  writeFileSync(join(dir, "fail"), fx.fail ?? "");
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/bash
# gh api [--paginate] <url> --jq <program>
url="$3"; [ "$2" = "--paginate" ] || url="$2"
prog=""; while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && prog="$2"; shift; done
echo "$url" >> "$STUB_DIR/calls"
case "$url" in
  *actions/workflows/*) kind=runs ;;
  *check-runs*) kind=checks ;;
  *) echo "unexpected url $url" >&2; exit 2 ;;
esac
if [ "$(cat "$STUB_DIR/fail")" = "$kind" ]; then echo '{"message":"Bad credentials"}'; exit 1; fi
jq -r "$prog" "$STUB_DIR/fixture.json"
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const run = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_DIR: dir,
      REPO: "o/r",
      SHA,
      INTERVAL: "0",
      MAX_ATTEMPTS: "3",
      GRACE_ATTEMPTS: "2",
      ...env,
    },
  });
  return {
    status: run.status,
    out: run.stdout + run.stderr,
    calls: readFileSync(join(dir, "calls"), "utf8"),
  };
}

const ci = (over: Partial<CheckRow> = {}): CheckRow => ({
  id: 100,
  status: "completed",
  conclusion: "success",
  run: 1,
  ...over,
});

describe("tools/require-ci-ok.sh", () => {
  it("passes on a successful CI OK from a push run of ci.yml on the SHA", () => {
    const r = gate({ runs: [{ id: 1, status: "completed" }], checks: [ci()] });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("concluded success");
    // Reads ci.yml's own run list for this SHA and the check runs named CI OK.
    expect(r.calls).toContain("actions/workflows/ci.yml/runs?head_sha=" + SHA);
    expect(r.calls).toContain("check_name=CI%20OK");
  });

  it.each(["failure", "cancelled", "timed_out", "skipped", "neutral"])(
    "refuses a CI OK that concluded %s",
    (conclusion) => {
      const r = gate({
        runs: [{ id: 1, status: "completed" }],
        checks: [ci({ conclusion })],
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain(`concluded ${conclusion}`);
    },
  );

  it("refuses when the CI run finished without a CI OK check run", () => {
    const r = gate({ runs: [{ id: 1, status: "completed" }], checks: [] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("without a 'CI OK' check run");
  });

  it("refuses when ci.yml has no push run on the SHA, after the grace polls", () => {
    const r = gate({ runs: [], checks: [] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("no push run");
    expect(r.out).toContain("No CI run registered");
  });

  it("does not accept a CI OK from another workflow's run", () => {
    // Run 9 belongs to some other workflow (not in ci.yml's run list for the SHA).
    const r = gate({
      runs: [{ id: 1, status: "completed" }],
      checks: [ci({ run: 9 })],
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("without a 'CI OK' check run");
  });

  it("does not accept a check named CI OK from an app other than github-actions", () => {
    const r = gate({
      runs: [{ id: 1, status: "completed" }],
      checks: [ci({ app: "evil-app" })],
    });
    expect(r.status).toBe(1);
  });

  it("ignores ci.yml runs of another SHA, a pull request, or another workflow path", () => {
    const r = gate({
      runs: [
        { id: 1, status: "completed", head_sha: OTHER },
        { id: 2, status: "completed", event: "pull_request" },
        { id: 3, status: "completed", path: ".github/workflows/evil.yml" },
      ],
      checks: [
        ci({ run: 1 }),
        ci({ id: 101, run: 2 }),
        ci({ id: 102, run: 3 }),
      ],
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("no push run");
  });

  it("the newest CI OK decides: a later failure beats an earlier success", () => {
    const r = gate({
      runs: [{ id: 1, status: "completed" }],
      checks: [ci({ id: 100 }), ci({ id: 200, conclusion: "failure" })],
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("concluded failure");
  });

  it("a green rerun after a failure passes", () => {
    const r = gate({
      runs: [{ id: 1, status: "completed" }],
      checks: [ci({ id: 100, conclusion: "failure" }), ci({ id: 200 })],
    });
    expect(r.status, r.out).toBe(0);
  });

  it("polls while CI is in progress and is bounded", () => {
    const r = gate({
      runs: [{ id: 1, status: "in_progress" }],
      checks: [ci({ status: "in_progress", conclusion: null })],
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("(attempt 2/3)");
    expect(r.out).toContain("did not finish within");
  });

  it("polls while the CI run is open but CI OK has not started", () => {
    const r = gate({ runs: [{ id: 1, status: "in_progress" }], checks: [] });
    expect(r.status).toBe(1);
    expect(r.out).toContain("CI is still running");
  });

  it.each(["runs", "checks"] as const)(
    "fails closed on an API error reading the %s",
    (fail) => {
      const r = gate({
        runs: [{ id: 1, status: "completed" }],
        checks: [ci()],
        fail,
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("could not");
      expect(r.out).not.toContain("concluded success");
    },
  );

  it("waits up to 120 minutes by default", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toContain('MAX_ATTEMPTS="${MAX_ATTEMPTS:-240}"');
    expect(text).toContain('INTERVAL="${INTERVAL:-30}"');
  });
});
