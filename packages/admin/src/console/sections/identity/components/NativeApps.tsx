/**
 * App sign-in → Native apps (I-15.2; WIRE-CONTRACT-V5 §12.12): how a desktop or mobile app gets its
 * sign-in code back. Loopback needs no registration and is on unless turned off; a registered URL
 * scheme or a claimed HTTPS path is accepted only when listed here. The rows are settings-engine
 * rows (`identity.nativeRedirect.*`): the manifest's value shows with its badge, and a console edit
 * claims it as for every row-backed key.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { reads } from "../../../data/reads.js";
import { ProductSettingsSection } from "../../../components/ProductSettingsSection.js";

export const NATIVE_REDIRECT_AREA = "identity.nativeRedirect";
const LOOPBACK = "identity.nativeRedirect.loopback";
export const NATIVE_REDIRECT_KEYS: readonly string[] = [
  LOOPBACK,
  "identity.nativeRedirect.schemes",
  "identity.nativeRedirect.claimedPaths",
];

/** Whether the area has the rows (Identity on, the view allowed to read them). */
export function useNativeAppsVisible(slug: string): boolean {
  const q = useQuery(reads.productSettings(slug, NATIVE_REDIRECT_AREA));
  return q.data
    ? q.data.settings.some(
        (s) =>
          s.key === LOOPBACK &&
          (s.visibleWhen?.offBehaviour !== "hide" || s.serviceEnabled),
      )
    : true;
}

export function NativeAppsSection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  return (
    <ProductSettingsSection
      slug={slug}
      area={NATIVE_REDIRECT_AREA}
      keys={NATIVE_REDIRECT_KEYS}
      id="native-apps"
      title="Native apps"
      description="Where a desktop or mobile app receives its sign-in. A loopback address needs no setup. A URL scheme or an app link must be listed here first."
    />
  );
}
