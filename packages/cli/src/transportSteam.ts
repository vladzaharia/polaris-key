/**
 * `pkey transport steam-depot vdf` (P5-08; notes/E3 §B3, CONTENT §6.6 and §7): a content-only
 * SteamPipe build of one pack's depot, for `steamcmd +login <build account> +run_app_build
 * <out>/app_build_<app>.vdf +quit` (the build account and Steam Guard stay CI's).
 *
 *   <out>/app_build_<app>.vdf          AppBuild: the app, a description naming the pack release,
 *                                      ContentRoot, BuildOutput, the one depot, and SetLive only
 *                                      for a named branch (the default branch is promoted in
 *                                      Steamworks by a person, never from CI)
 *   <out>/depot_build_<depot>.vdf      DepotBuild: the depot, FileMapping of its content root
 *   <out>/content/<depot>/pkey_packs/<packId>/<packId>.pck (+ .pkey.json)
 *                                      the payload and its marker (a tree pack: the directory,
 *                                      with .pkey/pack.json inside)
 *
 * On the device P5-08's steam transport reads `<install dir>/pkey_packs/<packId>/` through
 * GodotSteam and never writes there. Paid packs are DLC depots (their own depot id under the base
 * app; ownership is P6-01's). A compatible pack floats on Steam (`TRANSPORT_FLOATS`): each new
 * pack release is a new content-only build on the branch. The command reports `pending` on every
 * steam outlet the pack is routed through, with the app, depot and branch; the build's own state
 * is Steamworks'.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  loadTransportPack,
  pickVariants,
  placePayload,
  reportTransport,
  requireRouted,
  type TransportCommon,
} from "./transport.js";

export const DEFAULT_STEAM_OUT = "build/pkey-transport/steam";
/** The depot directory the device reads (`<install dir>/pkey_packs/<packId>/`). */
export const STEAM_PACK_DIR = "pkey_packs";

export interface SteamVdfOptions extends TransportCommon {
  from: string;
  depot: string;
  /** The Steam app id; default the steam outlet's `appId`. */
  app?: string;
  /** The branch; default the steam outlet's `branches[channel]`. */
  branch?: string;
  channel?: string;
  setlive?: boolean;
  out?: string;
  variant?: string;
}

export interface SteamVdfResult {
  app: string;
  depot: string;
  branch: string;
  setlive: boolean;
  appBuild: string;
  depotBuild: string;
}

/** A VDF string literal: quotes and backslashes escaped; control characters refused. */
export function vdfString(s: string): string {
  if (/[\u0000-\u001f]/.test(s))
    throw new Error(
      `a VDF value cannot hold control characters (${JSON.stringify(s)}).`,
    );
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function appBuildVdf(o: {
  app: string;
  depot: string;
  desc: string;
  setlive: string | null;
}): string {
  return [
    `"AppBuild"`,
    `{`,
    `\t"AppID" ${vdfString(o.app)}`,
    `\t"Desc" ${vdfString(o.desc)}`,
    `\t"ContentRoot" ${vdfString("content/")}`,
    `\t"BuildOutput" ${vdfString("output/")}`,
    ...(o.setlive !== null ? [`\t"SetLive" ${vdfString(o.setlive)}`] : []),
    `\t"Depots"`,
    `\t{`,
    `\t\t${vdfString(o.depot)} ${vdfString(`depot_build_${o.depot}.vdf`)}`,
    `\t}`,
    `}`,
    ``,
  ].join("\n");
}

export function depotBuildVdf(o: { depot: string }): string {
  return [
    `"DepotBuild"`,
    `{`,
    `\t"DepotID" ${vdfString(o.depot)}`,
    `\t"ContentRoot" ${vdfString(`content/${o.depot}/`)}`,
    `\t"FileMapping"`,
    `\t{`,
    `\t\t"LocalPath" ${vdfString("*")}`,
    `\t\t"DepotPath" ${vdfString(".")}`,
    `\t\t"Recursive" ${vdfString("1")}`,
    `\t}`,
    `}`,
    ``,
  ].join("\n");
}

export async function steamVdf(o: SteamVdfOptions): Promise<SteamVdfResult> {
  if (!/^[0-9]{1,10}$/.test(o.depot))
    throw new Error(
      `--depot must be a numeric Steam depot id (got ${o.depot}).`,
    );
  const loaded = await loadTransportPack(o, o.from);
  const outlets = requireRouted(loaded, "steam-depot");
  const steam = (loaded.distribution?.outlets ?? []).filter(
    (x) => outlets.includes(x.id) && x.kind === "steam",
  );
  const app = o.app ?? steam.find((x) => x.identity.appId)?.identity.appId;
  if (!app || !/^[0-9]{1,10}$/.test(app))
    throw new Error(
      "--app is required (a numeric Steam app id): no steam outlet the pack is routed through declares appId.",
    );
  let branch = o.branch;
  if (!branch && o.channel)
    branch = steam.map((x) => x.identity.branches?.[o.channel!]).find(Boolean);
  if (!branch)
    throw new Error(
      `--branch is required${o.channel ? ` (no steam outlet maps channel ${o.channel} to a branch)` : " (or --channel with the outlet's branches map)"}.`,
    );
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(branch))
    throw new Error(`--branch ${branch} is not a Steam branch name.`);
  const isDefault = branch === "default" || branch === "public";
  if (o.setlive && isDefault)
    throw new Error(
      `--setlive cannot target the ${branch} branch: Steam's default branch is set live in Steamworks by a person (SetLive applies to named branches only).`,
    );
  const [v, ...more] = pickVariants(loaded, o.variant);
  if (more.length || !v)
    throw new Error(
      `${loaded.pack.id} has ${loaded.variants.length} variants; a depot carries one: choose it with --variant.`,
    );

  const out = path.resolve(o.cwd, o.out ?? DEFAULT_STEAM_OUT);
  const contentRoot = path.join(out, "content", o.depot);
  await rm(contentRoot, { recursive: true, force: true });
  await placePayload(
    loaded,
    v,
    path.join(contentRoot, STEAM_PACK_DIR, loaded.pack.id),
    loaded.pack.id,
  );
  await mkdir(out, { recursive: true });
  const appBuild = path.join(out, `app_build_${app}.vdf`);
  const depotBuild = path.join(out, `depot_build_${o.depot}.vdf`);
  const desc = `pkey ${loaded.pack.id}@${o.version} (${loaded.recordSha256.slice(0, 12)})`;
  await writeFile(
    appBuild,
    appBuildVdf({
      app,
      depot: o.depot,
      desc,
      setlive: o.setlive ? branch : null,
    }),
  );
  await writeFile(depotBuild, depotBuildVdf({ depot: o.depot }));
  o.stdout.write(
    `Wrote a content-only SteamPipe build of depot ${o.depot} (${loaded.pack.id}@${o.version}) for app ${app}${o.setlive ? `, set live on ${branch}` : `; set ${branch} live in Steamworks`}: steamcmd +login <account> +run_app_build ${path.relative(o.cwd, appBuild) || appBuild} +quit\n`,
  );
  await reportTransport(o, loaded, outlets, "pending", {
    steamAppId: app,
    steamDepotId: o.depot,
    steamBranch: branch,
  });
  return {
    app,
    depot: o.depot,
    branch,
    setlive: Boolean(o.setlive),
    appBuild,
    depotBuild,
  };
}
