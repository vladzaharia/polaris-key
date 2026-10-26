/**
 * App sign-in → Platform sign-in (CC-01 auto sign-in, I-42.2): the Google and Apple audiences an
 * app's own token is checked against, and the nearby-device switch. The rows are settings-engine
 * rows (`identity.platformSignIn.*`, `identity.nearby`): the manifest's value shows with its
 * badge, and a console edit claims it as for every row-backed key. Bundle ids of the App Store
 * and TestFlight channels count too; they are read from the channels, never edited here.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProductSetting } from "../../../../api.js";
import { reads } from "../../../data/reads.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";

export const PLATFORM_SIGN_IN_AREA = "identity.platformSignIn";
const OUTLETS_AREA = "distribution.outlets";
const OUTLETS_KEY = "distribution.outlets";
const K = {
  google: "identity.platformSignIn.google.serverClientId",
  apps: "identity.platformSignIn.google.clientIds",
  team: "identity.platformSignIn.apple.teamId",
  bundles: "identity.platformSignIn.apple.bundleIds",
  nearby: "identity.nearby",
} as const;
export const PLATFORM_SIGN_IN_KEYS: readonly string[] = [
  K.google,
  K.apps,
  K.team,
  K.bundles,
  K.nearby,
];

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

/** One status line each: what the values in force make work. */
export function platformSignInStatus(
  value: (key: string) => unknown,
  outlet: readonly string[],
): { google: string; apple: string } {
  const web = typeof value(K.google) === "string";
  const apps = listOf(value(K.apps)).length > 0;
  const team = typeof value(K.team) === "string";
  const bundles = listOf(value(K.bundles)).length + outlet.length > 0;
  return {
    google: !web
      ? "Not set up"
      : apps
        ? "Ready on the web and in your apps"
        : "Ready on the web",
    apple: team && bundles ? "Ready" : "Not set up",
  };
}

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
  const status = platformSignInStatus(value, outlet);
  const note = own.data ? (
    <ul className="space-y-0.5 pb-3 text-sm text-fg-muted">
      <li>
        <span className="font-medium text-fg">Google</span>: {status.google}
      </li>
      <li>
        <span className="font-medium text-fg">Apple</span>: {status.apple}
        {outlet.length > 0
          ? `. Also from your channels: ${outlet.join(", ")}`
          : ""}
      </li>
    </ul>
  ) : undefined;
  return (
    <ProductSettingsSection
      slug={slug}
      area={PLATFORM_SIGN_IN_AREA}
      keys={PLATFORM_SIGN_IN_KEYS}
      id="platform-sign-in"
      title="Platform sign-in"
      description="What Google and Apple tokens from your app are checked against."
      note={note}
    />
  );
}
