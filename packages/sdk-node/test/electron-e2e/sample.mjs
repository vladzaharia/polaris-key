// Prepare the Electron sample (examples/ui/electron) for the e2e harness.
//
//   node test/electron-e2e/sample.mjs install   install the sample's dependencies
//   node test/electron-e2e/sample.mjs build     build the sample (electron-forge package)
//   node test/electron-e2e/sample.mjs           both
//
// Inside the repo the sample sits outside the pnpm workspace and its two @polaris-key entries are
// unpublished, so npm cannot resolve them. `install` swaps in a package.json without them for the
// install and restores yours afterwards; the sample's Vite configs alias @polaris-key/node and
// @polaris-key/react to the repo's builds. Build those first:
//   pnpm --filter @polaris-key/node --filter @polaris-key/react build   (or `pnpm build`)
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

export const SAMPLE = fileURLToPath(
  new URL("../../../../examples/ui/electron/", import.meta.url),
);
const PACKAGES = fileURLToPath(new URL("../../../", import.meta.url));

export function sampleProblem() {
  if (!existsSync(`${PACKAGES}sdk-node/dist/index.js`))
    return "the repo's @polaris-key/node is not built: run `pnpm build` first";
  if (!existsSync(`${PACKAGES}sdk-react/dist/index.js`))
    return "the repo's @polaris-key/react is not built: run `pnpm build` first";
  if (!existsSync(`${SAMPLE}node_modules/electron/path.txt`))
    return `the Electron sample is not installed: run \`pnpm --filter @polaris-key/node test:electron:setup\` (node test/electron-e2e/sample.mjs install)`;
  if (!existsSync(`${SAMPLE}.vite/build/main.cjs`))
    return "the Electron sample is not built: run `pnpm --filter @polaris-key/node test:electron:setup` (node test/electron-e2e/sample.mjs build)";
  return null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: SAMPLE, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

export function install() {
  const pkg = `${SAMPLE}package.json`;
  const backup = `${SAMPLE}package.json.e2e-backup`;
  copyFileSync(pkg, backup);
  try {
    const json = JSON.parse(readFileSync(pkg, "utf8"));
    for (const name of Object.keys(json.dependencies ?? {}))
      if (name.startsWith("@polaris-key/")) delete json.dependencies[name];
    writeFileSync(pkg, JSON.stringify(json, null, 2));
    run("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"]);
    // npm may skip the lifecycle script (a user or CI `ignore-scripts`): fetch the binary here.
    if (!existsSync(`${SAMPLE}node_modules/electron/path.txt`))
      run("node", ["node_modules/electron/install.js"]);
  } finally {
    copyFileSync(backup, pkg);
    rmSync(backup);
  }
}

export function build() {
  rmSync(`${SAMPLE}.vite`, { recursive: true, force: true });
  run("node", [
    "node_modules/@electron-forge/cli/dist/electron-forge.js",
    "package",
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const what = process.argv[2] ?? "all";
  if (what === "install" || what === "all") install();
  if (what === "build" || what === "all") build();
}
