/**
 * `pkey transport play-pad modules` (P5-08; notes/E2 §A3, notes/S-05 §4.2): Play Asset Delivery
 * modules for a pack release, written into a Godot Android Gradle build (the custom build
 * template, `android/build/`).
 *
 * For a pack whose Play asset-pack name is `<name>` (`@polaris-key/manifest` `resolvePadPackNames`:
 * `.` and `-` become `_`, every play-pad pack of the product mapped at once, collisions refused):
 *
 *   <project>/<name>/build.gradle                       `com.android.asset-pack`, packName <name>,
 *                                                       deliveryType fast-follow or on-demand
 *   <project>/<name>/src/main/assets/pkey/<name>.pck (+ .pkey.json)        the default variant
 *   <project>/<name>/src/main/assets/pkey#tcf_<fmt>/<name>.pck (+ .pkey.json)
 *                                                       one directory per other texture variant
 *                                                       (Play's texture compression format
 *                                                       targeting: a default directory is
 *                                                       mandatory; each device receives one)
 *
 * and patches the build: `include ':<name>'` in settings.gradle, `":<name>"` in the app's
 * `assetPacks` list (Godot's template declares `assetPacks = [":assetPackInstallTime"]`), and,
 * when any variant is texture-targeted, a separate `android { bundle { texture { enableSplit
 * true } } }` block. Every edit is idempotent. A tree pack's variant is the directory
 * `pkey/<name>/` (or `pkey#tcf_<fmt>/<name>/`) with `.pkey/pack.json` inside.
 *
 * On the device, P5-08's play_pad transport reads `assetsPath()` fresh every launch (the path
 * holds the versionCode) and looks under `pkey/` and any `pkey#tcf_<fmt>/` directory for the marker.
 * PAD packs change only with a new app bundle, so a pack delivered by PAD is pinned on Play
 * (`TRANSPORT_FLOATS["play-pad"]` is false) and its availability is the bundle's: this command
 * reports `pending` with the module's name and delivery type, and P5-03's Play mirror (or the
 * bundle upload's own report) moves it on.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePadPackNames } from "@polaris-key/manifest";
import {
  loadTransportPack,
  packsOn,
  pickVariants,
  placePayload,
  reportTransport,
  requireRouted,
  type TransportCommon,
  type TransportVariant,
} from "./transport.js";

/** Godot's texture variant values → Play's texture-compression-format aliases (bundletool). */
export const TCF_ALIASES: Readonly<Record<string, string>> = {
  astc: "astc",
  etc2: "etc2",
  etc: "etc1",
  etc1: "etc1",
  s3tc: "s3tc",
  dxt1: "dxt1",
  pvrtc: "pvrtc",
  atc: "atc",
  latc: "latc",
  "3dc": "3dc",
  paletted: "paletted",
};

export type PadDelivery = "fast-follow" | "on-demand";

export interface PadModulesOptions extends TransportCommon {
  from: string;
  /** The Godot Android Gradle build directory (`android/build`). */
  project: string;
  /** Default: `fast-follow` for essential and prefetch packs, `on-demand` otherwise. */
  delivery?: PadDelivery;
  /** The texture variant shipped unsuffixed (default `etc2` when published, else the first). */
  defaultTexture?: string;
  variant?: string;
}

export interface PadModulesResult {
  name: string;
  delivery: PadDelivery;
  /** Asset directories written, relative to the module's `src/main/assets`. */
  directories: string[];
  patched: string[];
}

export function padModuleGradle(name: string, delivery: PadDelivery): string {
  return `// Written by pkey transport play-pad modules (Polaris Key). Regenerated on every run.
plugins {
    id 'com.android.asset-pack'
}

assetPack {
    packName = "${name}"
    dynamicDelivery {
        deliveryType = "${delivery}"
    }
}
`;
}

const TEXTURE_BLOCK_MARK =
  "// pkey transport play-pad: texture compression format targeting";
const TEXTURE_BLOCK = `
${TEXTURE_BLOCK_MARK} (#tcf_ directories).
android {
    bundle {
        texture {
            enableSplit true
        }
    }
}
`;

/** settings.gradle with `include ':<name>'` (after the last include), unchanged when present. */
export function patchSettingsGradle(text: string, name: string): string {
  const line = `include ':${name}'`;
  if (text.split(/\r?\n/).some((l) => l.trim() === line)) return text;
  const lines = text.split("\n");
  let at = -1;
  lines.forEach((l, i) => {
    if (/^\s*include\s+['"]:/.test(l)) at = i;
  });
  if (at < 0) {
    const sep = text.endsWith("\n") ? "" : "\n";
    return `${text}${sep}${line}\n`;
  }
  lines.splice(at + 1, 0, line);
  return lines.join("\n");
}

/** The app build.gradle with `":<name>"` in `assetPacks` (and the texture block when asked). */
export function patchAppGradle(
  text: string,
  name: string,
  textureSplit: boolean,
): string {
  const re = /^(\s*assetPacks\s*=\s*\[)([^\]]*)(\])/m;
  const m = re.exec(text);
  if (!m)
    throw new Error(
      'build.gradle declares no assetPacks = [...] list: --project must be a Godot Android Gradle build (android/build, from "Install Android Build Template").',
    );
  const items = m[2]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let out = text;
  if (!items.some((s) => s === `":${name}"` || s === `':${name}'`)) {
    const next = [...items, `":${name}"`].join(", ");
    out = out.replace(re, `$1${next}$3`);
  }
  if (textureSplit && !out.includes(TEXTURE_BLOCK_MARK))
    out = `${out}${out.endsWith("\n") ? "" : "\n"}${TEXTURE_BLOCK}`;
  return out;
}

/** The asset directory of each variant: `pkey` for the default, `pkey#tcf_<alias>` for others. */
export function padDirectories(
  variants: readonly TransportVariant[],
  defaultTexture?: string,
): Map<TransportVariant, string> {
  const out = new Map<TransportVariant, string>();
  const textured = variants.filter((v) => v.variant.texture !== undefined);
  if (!textured.length) {
    if (variants.length !== 1)
      throw new Error("a Play asset pack carries one untargeted variant.");
    out.set(variants[0]!, "pkey");
    return out;
  }
  const values = textured.map((v) => v.variant.texture!);
  const def = defaultTexture ?? (values.includes("etc2") ? "etc2" : values[0]!);
  if (!values.includes(def))
    throw new Error(
      `--default-texture ${def} is not a published texture variant (published: ${values.join(", ")}).`,
    );
  for (const v of textured) {
    const t = v.variant.texture!;
    if (t === def) {
      out.set(v, "pkey");
      continue;
    }
    const alias = TCF_ALIASES[t];
    if (!alias)
      throw new Error(
        `texture variant ${t} has no Play texture-compression-format alias (${Object.keys(TCF_ALIASES).join(", ")}); make it the default with --default-texture or leave it to pkey-cdn.`,
      );
    out.set(v, `pkey#tcf_${alias}`);
  }
  return out;
}

export async function padModules(
  o: PadModulesOptions,
): Promise<PadModulesResult> {
  const loaded = await loadTransportPack(o, o.from);
  const outlets = requireRouted(loaded, "play-pad");
  const names = resolvePadPackNames([
    ...packsOn(loaded, "play-pad"),
    loaded.pack.id,
  ]);
  const name = names.get(loaded.pack.id)!;
  const delivery: PadDelivery =
    o.delivery ??
    (loaded.pack.delivery === "essential" || loaded.pack.delivery === "prefetch"
      ? "fast-follow"
      : "on-demand");
  if (delivery !== "fast-follow" && delivery !== "on-demand")
    throw new Error(
      `--delivery must be fast-follow or on-demand (install-time content is Godot's own assetPackInstallTime, an embedded baseline).`,
    );
  const variants = pickVariants(loaded, o.variant, ["texture"]);
  const dirs = padDirectories(variants, o.defaultTexture);

  const project = path.resolve(o.cwd, o.project);
  const settingsFile = path.join(project, "settings.gradle");
  const appFile = path.join(project, "build.gradle");
  const settings = await readFile(settingsFile, "utf8").catch(() => {
    throw new Error(
      `${path.relative(o.cwd, settingsFile)} is missing: --project must be a Godot Android Gradle build (android/build).`,
    );
  });
  const app = await readFile(appFile, "utf8");
  const textured = [...dirs.values()].some((d) => d !== "pkey");
  const nextApp = patchAppGradle(app, name, textured);
  const nextSettings = patchSettingsGradle(settings, name);

  const moduleDir = path.join(project, name);
  await rm(moduleDir, { recursive: true, force: true });
  const assets = path.join(moduleDir, "src", "main", "assets");
  const written: string[] = [];
  for (const [v, d] of [...dirs.entries()].sort(([, a], [, b]) =>
    a < b ? -1 : 1,
  )) {
    const target =
      v.layout === "container"
        ? path.join(assets, d)
        : path.join(assets, d, name);
    await placePayload(loaded, v, target, name);
    written.push(v.layout === "container" ? d : `${d}/${name}`);
  }
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    path.join(moduleDir, "build.gradle"),
    padModuleGradle(name, delivery),
  );
  const patched: string[] = [];
  if (nextSettings !== settings) {
    await writeFile(settingsFile, nextSettings);
    patched.push("settings.gradle");
  }
  if (nextApp !== app) {
    await writeFile(appFile, nextApp);
    patched.push("build.gradle");
  }
  o.stdout.write(
    `Wrote Play asset pack :${name} (${delivery}; ${written.join(", ")}) for ${loaded.pack.id}@${o.version}${patched.length ? `; patched ${patched.join(", ")}` : ""}\n`,
  );
  await reportTransport(o, loaded, outlets, "pending", {
    padPack: name,
    deliveryType: delivery,
  });
  return { name, delivery, directories: written, patched };
}
