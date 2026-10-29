/**
 * App sign-in → Platform sign-in (CC-01 auto sign-in, I-42.2): the Google and Apple audiences an
 * app's own token is checked against, and the nearby-device switch. The rows are settings-engine
 * rows (`identity.platformSignIn.*`, `identity.nearby`): the manifest's value shows with its
 * badge, and a console edit claims it as for every row-backed key. Bundle ids of the App Store
 * and TestFlight channels count too; they are read from the channels, never edited here.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { OutletCredentialInfo, ProductSetting } from "../../../../api.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { reads } from "../../../data/reads.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { credentialsQuery } from "../../distribution/data.js";
import { linkClass } from "./SignInSections.js";

export const PLATFORM_SIGN_IN_AREA = "identity.platformSignIn";
const OUTLETS_AREA = "distribution.outlets";
const OUTLETS_KEY = "distribution.outlets";
const K = {
  google: "identity.platformSignIn.google.serverClientId",
  apps: "identity.platformSignIn.google.clientIds",
  team: "identity.platformSignIn.apple.teamId",
  bundles: "identity.platformSignIn.apple.bundleIds",
  gameCenter: "identity.platformSignIn.gameCenter",
  playApp: "identity.platformSignIn.playGames.applicationId",
  playServer: "identity.platformSignIn.playGames.serverClientId",
  nearby: "identity.nearby",
} as const;
export const PLATFORM_SIGN_IN_KEYS: readonly string[] = [
  K.google,
  K.apps,
  K.team,
  K.bundles,
  K.gameCenter,
  K.playApp,
  K.playServer,
  K.nearby,
];

/** The outlet-credential kind of the Play Games game server credential (I-14.4). */
export const PGS_CREDENTIAL_KIND = "pgs-server-client";

/** The bundle ids of the App Store and TestFlight channels, from the channels row's value. */
export function outletBundleIds(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).map(([id, o]) => ({ id, ...(o as object) }))
      : [];
  const out = new Set<string>();
  for (const o of list as {
    id?: string;
    kind?: string;
    identity?: { bundleId?: unknown };
    bundleId?: unknown;
  }[]) {
    const kind = o.kind ?? o.id;
    const id = o.identity?.bundleId ?? o.bundleId;
    if (
      (kind === "app-store" || kind === "testflight") &&
      typeof id === "string"
    )
      out.add(id);
  }
  return [...out].sort();
}

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Where the Play Games server credential stands for the server client id the product names (the
 * Worker redeems only with an active one pinned to that id): `loading` while the read is out,
 * `unknown` when this reader cannot see credentials.
 */
export type CredentialState =
  | "loading"
  | "unknown"
  | "set"
  | "missing"
  | "mismatch"
  | "failing";

/** The credential the product's server client id is served by, and how it stands. */
export function credentialStanding(
  list: readonly OutletCredentialInfo[] | undefined,
  loading: boolean,
  serverClientId: unknown,
): { state: CredentialState; held: OutletCredentialInfo | undefined } {
  if (loading) return { state: "loading", held: undefined };
  if (!list) return { state: "unknown", held: undefined };
  const all = list.filter((c) => c.kind === PGS_CREDENTIAL_KIND);
  const same = all.filter((c) => c.meta.serverClientId === serverClientId);
  const live = same.find((c) => c.status === "active" && !c.lastError);
  if (live) return { state: "set", held: live };
  if (same.length) return { state: "failing", held: same[0] };
  if (all.length) return { state: "mismatch", held: all[0] };
  return { state: "missing", held: undefined };
}

/** One provider's line: a word and its tone, what it rests on, and its one action. */
export interface ProviderStatus {
  label: string;
  tone: "success" | "warning" | "neutral";
  detail?: string;
  /** `set` opens the credential's Set drawer; `open` opens its row. */
  action?: "set" | "open";
  /** The line waits on a read that is still out. */
  hold?: boolean;
}

/** One status each: what the values in force make work. */
export function platformSignInStatus(
  value: (key: string) => unknown,
  outlet: readonly string[],
  credential: CredentialState = "unknown",
): Record<"google" | "apple" | "gameCenter" | "playGames", ProviderStatus> {
  const web = typeof value(K.google) === "string";
  const apps = listOf(value(K.apps)).length > 0;
  const team = value(K.team);
  const bundleCount = unionCount(listOf(value(K.bundles)), outlet);
  const serverId = value(K.playServer);
  const play =
    typeof value(K.playApp) === "string" && typeof serverId === "string";
  const none: ProviderStatus = { label: "Not set up", tone: "neutral" };
  return {
    google: !web
      ? none
      : {
          label: "Ready",
          tone: "success",
          detail: apps ? "On the web and in your apps" : "On the web",
        },
    apple:
      typeof team === "string" && bundleCount > 0
        ? { label: "Ready", tone: "success" }
        : none,
    gameCenter:
      value(K.gameCenter) !== true
        ? { label: "Off", tone: "neutral" }
        : typeof team !== "string"
          ? { label: "Needs the Apple team id", tone: "warning" }
          : bundleCount === 0
            ? { label: "Needs a bundle id", tone: "warning" }
            : {
                label: "Ready",
                tone: "success",
                detail: `Team ${team}, ${bundleCount} bundle ${bundleCount === 1 ? "id" : "ids"}`,
              },
    playGames: !play
      ? none
      : credential === "loading"
        ? { label: "", tone: "neutral", hold: true }
        : credential === "unknown"
          ? { label: "Ids set", tone: "neutral" }
          : credential === "set"
            ? { label: "Ready", tone: "success", action: "open" }
            : credential === "missing"
              ? {
                  label: "Needs a server credential",
                  tone: "warning",
                  detail: `for ${serverId}`,
                  action: "set",
                }
              : credential === "mismatch"
                ? {
                    label: "Needs a server credential",
                    tone: "warning",
                    detail: `for ${serverId}`,
                    action: "open",
                  }
                : {
                    label: "Server credential failing",
                    tone: "warning",
                    action: "open",
                  },
  };
}

const plural = (n: number): string => `${n} bundle ${n === 1 ? "id" : "ids"}`;

const unionCount = (a: readonly string[], b: readonly string[]): number =>
  new Set([...a, ...b]).size;

/** Whether the area has the rows (Identity on, the view allowed to read them). */
export function usePlatformSignInVisible(slug: string): boolean {
  const q = useQuery(reads.productSettings(slug, PLATFORM_SIGN_IN_AREA));
  return q.data
    ? q.data.settings.some(
        (s) =>
          s.key === K.google &&
          (s.visibleWhen?.offBehaviour !== "hide" || s.serviceEnabled),
      )
    : true;
}

export function PlatformSignInSection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const own = useQuery(reads.productSettings(slug, PLATFORM_SIGN_IN_AREA));
  const outlets = useQuery(reads.productSettings(slug, OUTLETS_AREA));
  const rows: readonly ProductSetting[] = own.data?.settings ?? [];
  const value = (key: string): unknown =>
    rows.find((s) => s.key === key)?.value;
  const outlet = outletBundleIds(
    outlets.data?.settings.find((s) => s.key === OUTLETS_KEY)?.value,
  );
  const creds = useQuery({ ...credentialsQuery(slug), retry: false });
  const { state, held } = credentialStanding(
    creds.data?.credentials,
    creds.isPending,
    value(K.playServer),
  );
  const status = platformSignInStatus(value, outlet, state);
  const actionTo = (a: "set" | "open"): string =>
    a === "set"
      ? `${r.credentials(slug)}?set=${PGS_CREDENTIAL_KIND}`
      : held
        ? `${r.credentials(slug)}?credential=${encodeURIComponent(held.id)}`
        : r.credentials(slug);
  const lines: [string, ProviderStatus, string][] = [
    ["Google", status.google, ""],
    [
      "Apple",
      status.apple,
      outlet.length > 0 ? `Also from your channels: ${outlet.join(", ")}` : "",
    ],
    ["Game Center", status.gameCenter, ""],
    ["Play Games", status.playGames, ""],
  ];
  const note = own.data ? (
    <ul className="divide-y divide-border text-sm">
      {lines.map(([name, st, extra]) => (
        <li
          key={name}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
        >
          <span className="w-28 shrink-0 font-medium text-fg-strong">
            {name}
          </span>
          {st.hold ? (
            <Skeleton className="h-5 w-24" />
          ) : (
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
          )}
          {st.detail || extra ? (
            <span className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">
              {[st.detail, extra].filter(Boolean).join(". ")}
            </span>
          ) : null}
          {st.action ? (
            <Link to={actionTo(st.action)} className={`${linkClass} ms-auto`}>
              {st.label === "Ready"
                ? "Server credential"
                : st.action === "set"
                  ? "Set it"
                  : "Fix it"}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  ) : undefined;
  return (
    <ProductSettingsSection
      slug={slug}
      area={PLATFORM_SIGN_IN_AREA}
      keys={PLATFORM_SIGN_IN_KEYS}
      id="platform-sign-in"
      title="Platform sign-in"
      description="What Google, Apple, Game Center and Play Games tokens from your app are checked against."
      note={note}
      copy={{
        [K.gameCenter]: {
          confirm: (to) =>
            to === true
              ? {
                  title: "Turn on Game Center?",
                  confirmLabel: "Turn on Game Center",
                }
              : {
                  title: "Turn off Game Center?",
                  confirmLabel: "Turn off Game Center",
                },
          consequences: (to) =>
            to === true
              ? [
                  typeof value(K.team) === "string"
                    ? `Players can sign in with Game Center in apps from team ${String(value(K.team))} (${plural(unionCount(listOf(value(K.bundles)), outlet))}).`
                    : "Players can sign in with Game Center once the Apple team id and a bundle id are set.",
                ]
              : ["Players can no longer sign in with Game Center."],
        },
      }}
    />
  );
}
