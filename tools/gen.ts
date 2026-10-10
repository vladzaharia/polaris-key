// `pnpm gen`: run the generators declared in tools/generators.ts.
//
//   pnpm gen                         # regenerate every family, in registry order
//   pnpm gen --check                 # fail (exit 1) when any family is stale; write nothing
//   pnpm gen --changed [--check]     # only the families whose inputs or outputs changed on this branch
//   pnpm gen --fast --check          # only the cheap families (the pre-commit hook)
//   pnpm gen corpus brand            # named families, in registry order
//   pnpm gen --list                  # the registry, one line per family
//
// A named manual family forwards any other `--flag value` to its generator
// (`pnpm gen mirrors --catalog products/x/catalog.json --out-dir out`).
// Every family runs even when an earlier one fails, so one run lists every stale family.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkSteps,
  defaultFamilies,
  familiesTouching,
  GENERATORS,
  type Cmd,
  type Generator,
} from "./generators.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OWN_FLAGS = new Set([
  "--check",
  "--changed",
  "--fast",
  "--list",
  "--help",
]);

export interface Options {
  check: boolean;
  changed: boolean;
  fast: boolean;
  list: boolean;
  names: string[];
  forward: string[];
}

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    check: false,
    changed: false,
    fast: false,
    list: false,
    names: [],
    forward: [],
  };
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--check") o.check = true;
    else if (a === "--changed") o.changed = true;
    else if (a === "--fast") o.fast = true;
    else if (a === "--list" || a === "--help") o.list = true;
    else if (a.startsWith("--")) {
      o.forward.push(a);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        o.forward.push(next);
        i++;
      }
    } else o.names.push(a);
  }
  return o;
}

/** Files changed on this branch since it left `main`, plus the working tree and untracked files. */
export function changedFiles(): string[] {
  const git = (...a: string[]): string[] => {
    const r = spawnSync("git", a, { cwd: ROOT, encoding: "utf8" });
    return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  };
  const mb = spawnSync("git", ["merge-base", "HEAD", "main"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const base = mb.status === 0 ? mb.stdout.trim() : "";
  return [
    ...new Set([
      ...(base ? git("diff", "--name-only", `${base}...HEAD`) : []),
      ...git("diff", "--name-only", "HEAD"),
      ...git("ls-files", "--others", "--exclude-standard"),
    ]),
  ];
}

export function select(
  o: Options,
  changed: () => string[] = changedFiles,
): Generator[] {
  if (o.names.length > 0) {
    const out: Generator[] = [];
    for (const n of o.names) {
      const g = GENERATORS.find((x) => x.id === n);
      if (!g)
        throw new Error(`unknown generator "${n}"; run \`pnpm gen --list\``);
      out.push(
        g.via ? (GENERATORS.find((x) => x.id === g.via) as Generator) : g,
      );
    }
    return [...new Set(out)].sort((a, b) => a.order - b.order);
  }
  let fams = o.changed ? familiesTouching(changed()) : defaultFamilies();
  if (o.fast) fams = fams.filter((g) => g.fast);
  return fams;
}

function run(cmd: Cmd, extra: string[]): number {
  const r = spawnSync(cmd.argv[0] as string, [...cmd.argv.slice(1), ...extra], {
    cwd: cmd.cwd ? join(ROOT, cmd.cwd) : ROOT,
    env: { ...process.env, ...cmd.env },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) console.error(r.error.message);
  return r.status ?? 1;
}

function list(): void {
  for (const g of [...GENERATORS].sort((a, b) => a.order - b.order)) {
    const tag = g.manual
      ? "manual"
      : g.via
        ? `via ${g.via}`
        : g.checkOnly
          ? "check-only"
          : "";
    console.log(`${g.id.padEnd(20)} ${g.title}${tag ? ` [${tag}]` : ""}`);
  }
}

function main(): number {
  const o = parseArgs(process.argv.slice(2));
  if (o.list) {
    list();
    return 0;
  }
  const fams = select(o);
  if (fams.length === 0) {
    console.log("gen: nothing to do");
    return 0;
  }
  const failed: string[] = [];
  for (const g of fams) {
    const steps = o.check || g.checkOnly ? checkSteps(g) : (g.write ?? []);
    if (steps.length === 0) {
      console.log(
        `=== gen ${g.id}: no generator in the repository (${g.manual ?? "nothing to run"})`,
      );
      continue;
    }
    console.log(`=== gen${o.check ? " --check" : ""} ${g.id}`);
    const extra = o.names.length === 1 ? o.forward : [];
    const started = Date.now();
    let status = 0;
    steps.forEach((s, i) => {
      if (status !== 0) return;
      // Forwarded flags go to the step that runs the generator itself (the first).
      status = run(s, i === 0 ? extra : []);
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (status !== 0) {
      failed.push(g.id);
      console.error(`--- gen ${g.id} FAILED (${secs}s)`);
    } else console.log(`--- gen ${g.id} ok (${secs}s)`);
  }
  if (failed.length > 0) {
    console.error(
      `\ngen${o.check ? " --check" : ""}: ${failed.join(", ")} ${o.check ? "stale or failing; run `pnpm gen " + failed.join(" ") + "` and commit the result" : "failed"}`,
    );
    return 1;
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(main());
