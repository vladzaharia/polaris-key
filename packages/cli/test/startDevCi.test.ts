// start-dev-ci's `stop --job-status success` request-log check and its scope rule: the check is
// required when the lane's package was in the run's test scope (or nothing says otherwise), and
// skipped, with a notice, only when `start` recorded the package as out of scope.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/start-dev-ci.mjs",
);
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A lane state dir whose server is already gone and whose request log is empty. */
function lane(scope?: object | string): string {
  const dir = mkdtempSync(join(tmpdir(), "pkey-dev-ci-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "server.pid"), "999999999\n");
  writeFileSync(join(dir, "server.err.log"), "");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ product: "demo" }));
  if (scope !== undefined)
    writeFileSync(
      join(dir, "scope.json"),
      typeof scope === "string" ? scope : JSON.stringify(scope),
    );
  return dir;
}

function stop(dir: string, status: string) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "stop", "--dir", dir, "--job-status", status],
    { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } },
  );
  return { code: r.status, err: r.stderr };
}

const IN = { package: "@polaris-key/react", base: "abc", inScope: true };
const OUT = { package: "@polaris-key/react", base: "abc", inScope: false };

describe("start-dev-ci stop: the request log and the test scope", () => {
  it("fails a passing job whose in-scope suite made no requests", () => {
    const r = stop(lane(IN), "success");
    expect(r.code).toBe(1);
    expect(r.err).toContain("never made the requests SP-41 needs");
  });

  it("fails when no scope was recorded (a full run, or an older start)", () => {
    expect(stop(lane(), "success").code).toBe(1);
  });

  it("fails when the scope record is unreadable: the check stays strict", () => {
    expect(stop(lane("not json"), "success").code).toBe(1);
    expect(stop(lane({ inScope: "no" }), "success").code).toBe(1);
  });

  it("passes with a one-line notice when the lane's package was out of scope", () => {
    const r = stop(lane(OUT), "success");
    expect(r.code).toBe(0);
    const notice = r.err
      .split("\n")
      .filter((l) => l.includes("not in this run's test scope"));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain("@polaris-key/react");
    expect(r.err).not.toContain("never made the requests");
  });

  it("still fails an out-of-scope lane whose server never started", () => {
    const dir = lane(OUT);
    rmSync(join(dir, "server.pid"));
    expect(stop(dir, "success").code).toBe(1);
  });

  it("does not check traffic for a job that did not pass", () => {
    expect(stop(lane(IN), "failure").code).toBe(0);
  });
});
