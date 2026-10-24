/**
 * The agent-kit release builder (AX-07.2) and `pnpm skills:validate`.
 *
 *   tsx tools/agent-kit-release.ts --kit <dir> --version <semver> --out <dir>
 *       [--base-url <url>] [--local]
 *   tsx tools/agent-kit-release.ts --validate [--kit <dir>]
 *
 * The builder copies the kit's plugin files (`.claude-plugin/plugin.json`, `skills/**`,
 * `README.md`, and the repo's root `LICENSE`; never `package.json` or `scripts/`), stamps
 * `version` into the copy, writes `polaris-key-<version>.zip` with the CLI's deterministic STORE
 * writer (sorted entries, fixed timestamps: the same tree gives the same bytes) and a
 * `marketplace.json` naming the archive and its sha256. `--local` also writes a directory
 * marketplace under `<out>/local/`. Nothing is published.
 *
 * `--validate` builds into a temp dir and runs `claude plugin validate --strict` on the stamped
 * plugin, the archive marketplace and the local marketplace. The CLI is `PKEY_CLAUDE_BIN` (a
 * command line, split on spaces), else `claude` on PATH, else (only when CI=true) the pinned
 * `npx` below; with none it prints `skip: no claude CLI` and exits 0 (1 when CI=true).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { zipStore } from "../packages/cli/src/zip.js";

/**
 * The Claude Code release CI runs `claude plugin validate` with, through `npx`. Exact, never a
 * range, and at least 14 days old when pinned: 2.1.296 was published 2026-10-09.
 */
export const PINNED_CLAUDE_CODE = "2.1.296";
export const PINNED_CLAUDE_COMMAND = `npx --yes @anthropic-ai/claude-code@${PINNED_CLAUDE_CODE}`;

export const DEFAULT_BASE_URL = "https://key.plrs.im/docs/agents";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface BuildOptions {
  kit: string;
  version: string;
  out: string;
  baseUrl?: string;
  local?: boolean;
  /** The LICENSE to ship; defaults to the repo's root `LICENSE`. */
  license?: string;
}

export interface BuildResult {
  zipPath: string;
  zipSha256: string;
  marketplacePath: string;
  files: string[];
  localMarketplaceDir?: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The plugin's files, as archive-relative names and bytes, sorted by name. */
function collect(opts: BuildOptions): Array<{ name: string; data: Buffer }> {
  const kit = resolve(opts.kit);
  const files = new Map<string, Buffer>();
  const manifest = JSON.parse(
    readFileSync(join(kit, ".claude-plugin", "plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  manifest.version = opts.version;
  files.set(".claude-plugin/plugin.json", Buffer.from(json(manifest)));
  const skills = join(kit, "skills");
  for (const p of walk(skills))
    files.set(relative(kit, p).split(sep).join("/"), readFileSync(p));
  files.set("README.md", readFileSync(join(kit, "README.md")));
  files.set(
    "LICENSE",
    readFileSync(opts.license ?? join(REPO_ROOT, "LICENSE")),
  );
  return [...files]
    .map(([name, data]) => ({ name, data }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function buildKit(opts: BuildOptions): BuildResult {
  if (!SEMVER.test(opts.version))
    throw new Error(`"${opts.version}" is not a semver version`);
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const out = resolve(opts.out);
  const files = collect(opts);
  const manifest = JSON.parse(
    files.find((f) => f.name === ".claude-plugin/plugin.json")!.data.toString(),
  ) as { description?: string };
  const description = manifest.description ?? "Polaris Key agent skills";
  mkdirSync(out, { recursive: true });

  const zipName = `polaris-key-${opts.version}.zip`;
  const zip = zipStore(files);
  const zipPath = join(out, zipName);
  writeFileSync(zipPath, zip);
  const zipSha256 = sha256(zip);

  const owner = { name: "Polaris Key" };
  const marketplacePath = join(out, "marketplace.json");
  writeFileSync(
    marketplacePath,
    json({
      name: "polaris-key",
      owner,
      description,
      plugins: [
        {
          name: "polaris-key",
          description,
          version: opts.version,
          source: {
            source: "archive",
            url: `${base}/${zipName}`,
            sha256: zipSha256,
          },
        },
      ],
    }),
  );

  const result: BuildResult = {
    zipPath,
    zipSha256,
    marketplacePath,
    files: files.map((f) => f.name),
  };
  if (opts.local) {
    const local = join(out, "local");
    rmSync(local, { recursive: true, force: true });
    for (const f of files) {
      const p = join(local, "polaris-key", f.name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.data);
    }
    mkdirSync(join(local, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(local, ".claude-plugin", "marketplace.json"),
      json({
        name: "polaris-key",
        owner,
        description,
        plugins: [
          {
            name: "polaris-key",
            description,
            version: opts.version,
            source: "./polaris-key",
          },
        ],
      }),
    );
    result.localMarketplaceDir = local;
  }
  return result;
}

/** The claude command line to validate with, or null when none can run. */
export function claudeCommand(
  env: NodeJS.ProcessEnv = process.env,
  onPath: () => boolean = () =>
    spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0,
): string[] | null {
  if (env.PKEY_CLAUDE_BIN?.trim())
    return env.PKEY_CLAUDE_BIN.trim().split(/\s+/);
  if (onPath()) return ["claude"];
  if (env.CI === "true") return PINNED_CLAUDE_COMMAND.split(" ");
  return null;
}

function validate(kit: string): number {
  const cmd = claudeCommand();
  if (!cmd) {
    if (process.env.CI === "true") {
      console.error("no claude CLI (CI=true)");
      return 1;
    }
    console.log("skip: no claude CLI");
    return 0;
  }
  const tmp = mkdtempSync(join(tmpdir(), "agent-kit-validate-"));
  try {
    const built = buildKit({
      kit,
      version: "0.0.0-validate",
      out: tmp,
      local: true,
    });
    const targets = [
      join(built.localMarketplaceDir!, "polaris-key"),
      built.marketplacePath,
      built.localMarketplaceDir!,
    ];
    let failed = 0;
    for (const t of targets) {
      console.log(`claude plugin validate --strict ${relative(tmp, t) || "."}`);
      const r = spawnSync(
        cmd[0]!,
        [...cmd.slice(1), "plugin", "validate", "--strict", t],
        { stdio: "inherit" },
      );
      if (r.status !== 0) failed++;
    }
    return failed ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parse(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === "local" || key === "validate") args[key] = true;
    else {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--${key} needs a value`);
      args[key] = v;
    }
  }
  return args;
}

function main(argv: string[]): number {
  const a = parse(argv);
  const kit = (a.kit as string | undefined) ?? "packages/agent-kit";
  if (a.validate) return validate(kit);
  for (const k of ["kit", "version", "out"])
    if (typeof a[k] !== "string") throw new Error(`--${k} is required`);
  const r = buildKit({
    kit,
    version: a.version as string,
    out: a.out as string,
    baseUrl: a["base-url"] as string | undefined,
    local: a.local === true,
  });
  console.log(`${r.zipPath}\nsha256 ${r.zipSha256}\n${r.marketplacePath}`);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
