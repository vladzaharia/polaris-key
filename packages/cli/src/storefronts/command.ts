/**
 * `pkey storefront …` (A-18h): CI-plane store steps, every one through the store's command
 * allow-list and reported back into the ledger (`run.ts`).
 *
 *   itch push              butler push <dir> <identity target>:<platform[-channel]> --userversion <v>
 *   snap metadata          the listing's Snap projection → snapcraft.yaml (before the build)
 *   snap upload            snapcraft upload <snap> --release=<identity channels>
 *   snap upload-metadata   snapcraft upload-metadata <snap>
 *   exec <store> <command> any allow-listed command of a CI-plane store, its argv after `--`
 *                          (steamcmd, msstore, BuildPatchTool until their adapters add planners)
 *   allow-list             print the allow-lists (--json for the declaration)
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Out, Sleep } from "../ci.js";
import type { CiEnv } from "../oidc.js";
import { CI_PLANE } from "./ciPlane.generated.js";
import { bindsIdentity, ciAdapter, ciStore, ciStoreIds } from "./allowList.js";
import { itchPushStep } from "./itch.js";
import { loadStepProduct, pickOutlet, type StepOutlet } from "./outlets.js";
import { commandLine, runStoreSteps, type StoreStep } from "./run.js";
import {
  snapUploadMetadataStep,
  snapUploadStep,
  writeSnapMetadata,
} from "./snap.js";

export const STOREFRONT_USAGE =
  "Usage: pkey storefront itch push --platform windows|linux|mac|android --dir <dir> --version <v> [--channel c] [--outlet id]\n" +
  "       pkey storefront snap metadata --yaml <snapcraft.yaml>\n" +
  "       pkey storefront snap upload --snap <file.snap> --channel c[,c...] [--outlet id]\n" +
  "       pkey storefront snap upload-metadata --snap <file.snap>\n" +
  "       pkey storefront exec <store> <command> --op <operation> [--outlet id] [--tool-path p] -- <argv...>\n" +
  "       pkey storefront allow-list [--store s] [--json]\n" +
  "  (each step also takes --product slug, --base-url url, --dry-run, --no-report)";

export interface StorefrontArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Everything after `--`. */
  rest: string[];
}

export interface StorefrontIo {
  cwd: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

function str(a: StorefrontArgs, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === "string" && v.trim() ? v : undefined;
}
function bool(a: StorefrontArgs, name: string): boolean {
  return a.flags[name] === true || a.flags[name] === "true";
}
function need(a: StorefrontArgs, name: string, why: string): string {
  const v = str(a, name);
  if (!v)
    throw new Error(`--${name} is required: ${why}.\n${STOREFRONT_USAGE}`);
  return v;
}

/** The one `.snap` a path names: the file itself, or the only `.snap` in a directory. */
export async function resolveSnapFile(cwd: string, p: string): Promise<string> {
  const abs = path.resolve(cwd, p);
  if ((await stat(abs)).isFile()) return p;
  const snaps = (await readdir(abs)).filter((f) => f.endsWith(".snap"));
  if (snaps.length !== 1)
    throw new Error(
      `${p} holds ${snaps.length} .snap files; name one (${snaps.join(", ") || "none"}).`,
    );
  return path.join(p, snaps[0]!);
}

/** The snapcraft.yaml a path names: the file, or `<dir>/snapcraft.yaml`, or `<dir>/snap/snapcraft.yaml`. */
export async function resolveSnapcraftYaml(
  cwd: string,
  p: string,
): Promise<string> {
  const abs = path.resolve(cwd, p);
  if ((await stat(abs)).isFile()) return abs;
  for (const candidate of ["snapcraft.yaml", "snap/snapcraft.yaml"]) {
    const f = path.join(abs, candidate);
    try {
      if ((await stat(f)).isFile()) return f;
    } catch {
      // try the next
    }
  }
  throw new Error(`${p} has no snapcraft.yaml (or snap/snapcraft.yaml).`);
}

function printAllowList(a: StorefrontArgs, io: StorefrontIo): number {
  const only = str(a, "store");
  if (only && !ciStore(only))
    throw new Error(
      `--store must be one of ${ciStoreIds().join(", ")} (got ${only}).`,
    );
  const stores = CI_PLANE.stores.filter((s) => !only || s.store === only);
  if (bool(a, "json")) {
    io.stdout.write(
      `${JSON.stringify({ stores, adapters: CI_PLANE.adapters }, null, 2)}\n`,
    );
    return 0;
  }
  for (const s of stores) {
    io.stdout.write(`${s.label} (${s.store}): ${s.list.tool}\n`);
    for (const [id, rule] of Object.entries(s.list.commands)) {
      const argv = rule.argv.map((x) =>
        typeof x === "string"
          ? x
          : `${x.prefix ?? ""}<${x.param}${x.identity ? ` = identity ${x.identity.field}` : ""}>`,
      );
      io.stdout.write(
        `  ${id}: ${s.list.tool} ${argv.join(" ")}\n    ${rule.why}\n`,
      );
    }
  }
  return 0;
}

/** `pkey storefront …`. */
export async function cmdStorefront(
  a: StorefrontArgs,
  io: StorefrontIo,
): Promise<number> {
  const [store, step] = a.positional;
  if (store === "allow-list") return printAllowList(a, io);
  const productFlag = str(a, "product");
  const run = async (steps: StoreStep[], slug: string) => {
    await runStoreSteps(steps, {
      cwd: io.cwd,
      product: slug,
      baseUrl: str(a, "base-url"),
      env: io.env,
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: io.fetchImpl,
      sleep: io.sleep,
      dryRun: bool(a, "dry-run"),
      report: !bool(a, "no-report"),
      toolPath: str(a, "tool-path"),
    });
    return 0;
  };
  const outletFor = async (storeId: string) => {
    const p = await loadStepProduct(io.cwd, productFlag);
    const s = ciStore(storeId)!;
    return {
      slug: p.slug,
      outlet: pickOutlet(p, s.outletKinds, str(a, "outlet"), s.label),
    };
  };
  switch (`${store ?? ""} ${step ?? ""}`) {
    case "itch push": {
      const { slug, outlet } = await outletFor("itch");
      return run(
        [
          itchPushStep({
            outlet,
            dir: need(a, "dir", "the directory of the build to push"),
            platform: need(
              a,
              "platform",
              "the platform word the channel starts with",
            ),
            channel: str(a, "channel"),
            version: need(a, "version", "the --userversion butler records"),
          }),
        ],
        slug,
      );
    }
    case "snap upload": {
      const { slug, outlet } = await outletFor("snap");
      const snap = await resolveSnapFile(
        io.cwd,
        need(a, "snap", "the built .snap"),
      );
      const channels = need(
        a,
        "channel",
        "the release channel(s) to release to",
      )
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      return run([snapUploadStep({ outlet, snap, channels })], slug);
    }
    case "snap upload-metadata": {
      const p = await loadStepProduct(io.cwd, productFlag);
      const snap = await resolveSnapFile(
        io.cwd,
        need(a, "snap", "the built .snap"),
      );
      return run([snapUploadMetadataStep(snap)], p.slug);
    }
    case "snap metadata": {
      const p = await loadStepProduct(io.cwd, productFlag);
      await writeSnapMetadata({
        yamlPath: await resolveSnapcraftYaml(
          io.cwd,
          need(a, "yaml", "the snapcraft.yaml to update"),
        ),
        product: p.slug,
        baseUrl: str(a, "base-url"),
        env: io.env,
        stdout: io.stdout,
        stderr: io.stderr,
        fetchImpl: io.fetchImpl,
        sleep: io.sleep,
        dryRun: bool(a, "dry-run"),
      });
      return 0;
    }
    default:
      break;
  }
  if (store === "exec") {
    const [, storeId, command] = a.positional;
    const s = storeId ? ciStore(storeId) : null;
    if (!s)
      throw new Error(
        `pkey storefront exec needs a CI-plane store: ${ciStoreIds().join(", ")}.\n${STOREFRONT_USAGE}`,
      );
    if (!command || !Object.hasOwn(s.list.commands, command))
      throw new Error(
        `${s.label}'s allow-list has the commands ${Object.keys(s.list.commands).join(", ")}.\n${STOREFRONT_USAGE}`,
      );
    const op = need(
      a,
      "op",
      "the storefront operation the command performs (uploadBuild, release, writeListingText)",
    );
    const adapter = ciAdapter(s.store);
    if (adapter && !(adapter.ciOps[op] ?? []).includes(command))
      throw new Error(
        `${adapter.label} runs ${command} for ${
          Object.entries(adapter.ciOps)
            .filter(([, c]) => c.includes(command))
            .map(([o]) => o)
            .join(", ") || "no operation"
        }, not ${op}.`,
      );
    let slug: string;
    let outlet: StepOutlet | undefined;
    if (bindsIdentity(s.list, command) || str(a, "outlet")) {
      const r = await outletFor(s.store);
      slug = r.slug;
      outlet = r.outlet;
    } else slug = productFlag ?? (await loadStepProduct(io.cwd)).slug;
    return run(
      [
        {
          store: s.store,
          op,
          command,
          tool: s.list.tool,
          argv: [...a.rest],
          ...(outlet ? { outlet } : {}),
        },
      ],
      slug,
    );
  }
  io.stderr.write(`${STOREFRONT_USAGE}\n`);
  return 2;
}

export { commandLine };
