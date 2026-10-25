import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initManifest, runPkey } from "../src/index.js";

const made: string[] = [];
const tmp = async (): Promise<string> =>
  made[made.push(await mkdtemp(path.join(os.tmpdir(), "pkey-ciinit-"))) - 1]!;
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(): Promise<{ cwd: string; cfg: string }> {
  const cwd = await tmp();
  const cfg = await tmp();
  await initManifest({
    cwd,
    slug: "acme",
    name: "Acme",
    modules: ["license", "release"],
    releaseOwner: "acme-co",
    releaseRepo: "acme",
  });
  return { cwd, cfg };
}

type Ran = { code: number; out: string; err: string };

async function pkey(
  r: { cwd: string; cfg: string },
  ...argv: string[]
): Promise<Ran> {
  const ran: Ran = { code: 0, out: "", err: "" };
  ran.code = await runPkey(["ci", "init", ...argv], {
    cwd: r.cwd,
    env: { NO_COLOR: "1", XDG_CONFIG_HOME: r.cfg },
    stdout: { write: (c: string) => ((ran.out += c), true) },
    stderr: { write: (c: string) => ((ran.err += c), true) },
  });
  return ran;
}

const wf = (cwd: string) => path.join(cwd, ".github/workflows/release.yml");
const keyFile = (cfg: string) =>
  path.join(cfg, "pkey/release-keys/acme-release-1.pem");

describe("pkey ci init", () => {
  it("writes the workflow, declares a key, and stores the private half 0600", async () => {
    const r = await repo();
    const res = await pkey(r);
    expect(res).toMatchObject({ code: 0, err: "" });
    const flow = await readFile(wf(r.cwd), "utf8");
    expect(flow).toContain("name: Release");
    expect(flow).toContain("release-key: ${{ secrets.PKEY_RELEASE_KEY }}");
    const release = await readFile(
      path.join(r.cwd, ".pkey/release.yaml"),
      "utf8",
    );
    expect(release).toMatch(/kid: release-1\n\s+publicKey: [A-Za-z0-9_-]{43}/);
    const pem = await readFile(keyFile(r.cfg), "utf8");
    expect((await stat(keyFile(r.cfg))).mode & 0o777).toBe(0o600);
    // The private half is nowhere in the answer, the repo files or the workflow.
    for (const line of pem
      .split("\n")
      .filter((l) => l && !l.startsWith("---"))) {
      expect(res.out + res.err + flow + release).not.toContain(line);
    }
    expect(res.out).toContain(
      `gh secret set PKEY_RELEASE_KEY --env release < ${keyFile(r.cfg)}`,
    );
    expect(res.out).toContain("git tag v1.0.0");
    expect(res.out).toContain("<commit-sha>");
  });

  it("refuses an existing workflow without --force, and writes nothing", async () => {
    const r = await repo();
    await pkey(r);
    const again = await pkey(r);
    expect(again.code).toBe(1);
    expect(again.err).toContain(".github/workflows/release.yml exists");
    expect(again.out).toBe("");
  });

  it("--force replaces the workflow and keeps the declared key (generated once)", async () => {
    const r = await repo();
    await pkey(r);
    const release = await readFile(
      path.join(r.cwd, ".pkey/release.yaml"),
      "utf8",
    );
    await writeFile(wf(r.cwd), "old\n");
    const res = await pkey(r, "--force", "--channel", "beta");
    expect(res.code).toBe(0);
    expect(await readFile(wf(r.cwd), "utf8")).toContain("--channel beta");
    expect(await readFile(path.join(r.cwd, ".pkey/release.yaml"), "utf8")).toBe(
      release,
    );
    expect(res.out).toContain("Kept key release-1");
    expect(res.out).not.toContain("--env release <");
  });

  it("pins the Action with --action-ref", async () => {
    const r = await repo();
    const sha = "a".repeat(40);
    const res = await pkey(r, "--action-ref", sha);
    expect(res.code).toBe(0);
    expect(await readFile(wf(r.cwd), "utf8")).toContain(`@${sha}`);
    expect(res.out).not.toContain("<commit-sha>");
  });

  it("--json carries the public half and the key file, never the private half", async () => {
    const r = await repo();
    const res = await pkey(r, "--json");
    const j = JSON.parse(res.out) as Record<string, any>;
    expect(j).toMatchObject({
      command: "ci init",
      ok: true,
      workflow: ".github/workflows/release.yml",
      secret: "PKEY_RELEASE_KEY",
      environment: "release",
      key: { kid: "release-1", file: keyFile(r.cfg), mode: "0600" },
    });
    expect(res.out).not.toContain("PRIVATE");
    const pem = await readFile(keyFile(r.cfg), "utf8");
    for (const line of pem.split("\n").filter((l) => l && !l.startsWith("---")))
      expect(res.out).not.toContain(line);
  });

  it("refuses a key directory inside the repo", async () => {
    const r = await repo();
    const res = await pkey({ cwd: r.cwd, cfg: path.join(r.cwd, "cfg") });
    expect(res.code).toBe(1);
    expect(res.err).toContain("inside the repo");
    await expect(stat(wf(r.cwd))).rejects.toThrow();
  });

  it("needs .pkey/release, and writes nothing without it", async () => {
    const cwd = await tmp();
    const cfg = await tmp();
    await initManifest({
      cwd,
      slug: "acme",
      name: "Acme",
      modules: ["license"],
    });
    const res = await pkey({ cwd, cfg });
    expect(res.code).toBe(1);
    expect(res.err).toContain("No .pkey/release");
    await expect(stat(wf(cwd))).rejects.toThrow();
  });

  it("errors: no manifest, bad flags, unknown subcommand", async () => {
    const r = { cwd: await tmp(), cfg: await tmp() };
    const none = await pkey(r);
    expect(none.code).toBe(1);
    expect(none.err).toContain("No .pkey/product manifest");
    const j = JSON.parse((await pkey(r, "--json")).out) as Record<
      string,
      unknown
    >;
    expect(j).toMatchObject({ ok: false, error: "no-manifest" });
    const r2 = await repo();
    expect((await pkey(r2, "--channel", "Bad Channel")).code).toBe(2);
    expect((await pkey(r2, "--action-ref", "main")).code).toBe(2);
    expect((await pkey(r2, "--bogus")).code).toBe(2);
    await expect(stat(wf(r2.cwd))).rejects.toThrow();
  });
});
