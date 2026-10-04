/**
 * Godot (F-09's feeds): the addon's canonical reproducible zip, and an optional PNG icon. The
 * zip's `addons/<id>/plugin.cfg` gives the version, the display name, the author, the description
 * and the script (plans/F-01.md §6.8).
 */

import { withZip } from "../zip.js";
import { declaredFiles, exactlyOne } from "./files.js";
import {
  PackageExtractError,
  type Extracted,
  type ExtractedFile,
  type ExtractInput,
} from "./types.js";

/** The `[plugin]` section of a plugin.cfg, values unquoted. */
export function parsePluginCfg(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const s = /^\[([^\]]+)\]$/.exec(line);
    if (s) {
      section = s[1]!;
      continue;
    }
    if (section !== "plugin") continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2)
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
    out.set(kv[1]!, v);
  }
  return out;
}

export async function extractGodot(input: ExtractInput): Promise<Extracted> {
  const found = await declaredFiles(input);
  const zip = exactlyOne(
    found.filter((f) => f.name.endsWith(".zip")),
    "addon zip",
  );
  const icons = found.filter((f) => f.name.toLowerCase().endsWith(".png"));
  if (icons.length > 1)
    throw new PackageExtractError(
      `${icons.length} icons match (${icons.map((i) => i.name).join(", ")}); a release has at most one.`,
    );
  const cfg = await withZip(zip.path, async (z) => {
    const entry = z.entries.find(
      (e) => e.name === `addons/${input.declaration.name}/plugin.cfg`,
    );
    if (!entry)
      throw new PackageExtractError(
        `${zip.name} has no addons/${input.declaration.name}/plugin.cfg (the addon id is the package name).`,
      );
    return parsePluginCfg((await z.read(entry)).toString("utf8"));
  });
  const version = cfg.get("version");
  if (!version)
    throw new PackageExtractError(`${zip.name}'s plugin.cfg has no version.`);
  const files: ExtractedFile[] = [
    { path: zip.path, name: zip.name, type: "godot-zip" },
    ...(icons[0]
      ? [{ path: icons[0].path, name: icons[0].name, type: "godot-icon" }]
      : []),
  ];
  const metadata: Record<string, unknown> = {
    name: input.declaration.name,
    version,
  };
  for (const [k, key] of [
    ["name", "displayName"],
    ["author", "author"],
    ["description", "description"],
    ["script", "script"],
  ] as const) {
    const v = cfg.get(k);
    if (v) metadata[key] = v;
  }
  return { version, files, metadata };
}
