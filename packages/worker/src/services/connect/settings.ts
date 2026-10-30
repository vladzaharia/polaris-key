/**
 * Cloud Connect's settings slice (CC-02.2; plans/CC-01-cloud-connect.md §2.9), contributed through
 * the descriptor (`connectService.settings`), never imported by Core (rule 6).
 *
 * A person's relay bytes per day are the `pkey.cloudConnect.relayBytes` entitlement, read from the
 * device's anchor licence; no product setting carries a quota. The manifest's `connect:` block
 * seeds two claimable switches (`cloudConnect.relay.enabled`, `cloudConnect.interAccount`), and the
 * operator has one product ceiling (`cloudConnect.ceiling.relayBytes`). The platform default quota
 * and the kill switch live in Core's platform slice (`core/settings/platform.ts`), because a
 * service slice contributes product-scope entries only.
 *
 * CC-07.3 reads the relay switch and the ceiling (`relay/access.ts`). `cloudConnect.interAccount`
 * stays `pending` until inter-account links (CC-19.3), so the console does not offer it.
 */

import { CLOUD_CONNECT_CEILINGS } from "@polaris-key/catalog";
import { setting } from "../../core/settings/define.js";
import type { ServiceSettingsSlice } from "../../core/settings/types.js";

const VISIBLE = { service: "connect", offBehaviour: "hide" } as const;
const DOCS = "/docs/features/cloud-connect/";
const AREA = "cloudConnect";

/** The largest product ceiling the registry accepts (1 PiB); the bound only keeps it an integer. */
const CEILING_MAX_BYTES = 1024 ** 5;

export const CONNECT_SETTINGS_SLICE: ServiceSettingsSlice = {
  namespaces: ["cloudConnect"],
  entries: [
    setting({
      key: "cloudConnect.relay.enabled",
      scope: "product",
      service: "connect",
      area: AREA,
      label: "Relay",
      description:
        "Whether the relay carries this product's device traffic when the local network cannot. Turn it off and devices connect only on the same network.",
      keywords: ["relay", "connect", "remote"],
      docs: DOCS,
      value: { kind: "boolean" },
      defaultValue: true,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:connect.relay" },
      confirm: { on: "L0", off: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "CC-02.2",
      readers: ["services/connect/relay/access.ts"],
    }),
    setting({
      key: "cloudConnect.interAccount",
      scope: "product",
      service: "connect",
      area: AREA,
      label: "Connect across accounts",
      description:
        "Whether devices signed in to different accounts may connect. Off, a device connects only to those of its own account.",
      keywords: ["accounts", "connect", "share", "people"],
      docs: DOCS,
      value: { kind: "boolean" },
      defaultValue: false,
      merge: "cascade",
      ownership: "claimable",
      manifest: { path: "product:connect.interAccount" },
      // Turning it on widens who a device may reach, so it is confirmed and needs a reason.
      critical: true,
      confirm: { on: "L1", off: "L0" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "CC-02.2",
      pending: { wp: "CC-19" },
    }),
    // The operator's cost control: all relay bytes of every person on the product together, per
    // UTC month. Raising it costs the platform more, so it is confirmed more strictly than lowering.
    setting({
      key: "cloudConnect.ceiling.relayBytes",
      scope: "product",
      service: "connect",
      area: AREA,
      label: "Monthly relay ceiling",
      description:
        "The most relay data all people on the product may use together in a UTC month. Past it, the relay refuses new connections until the month turns; the local network is never metered.",
      keywords: ["quota", "relay", "ceiling", "cost", "bandwidth"],
      docs: DOCS,
      value: {
        kind: "integer",
        unit: "bytes",
        min: 0,
        max: CEILING_MAX_BYTES,
      },
      defaultValue: CLOUD_CONNECT_CEILINGS.perProduct.relayBytesPerMonth,
      merge: "cascade",
      ownership: "operator",
      critical: true,
      confirm: { up: "L2", down: "L1" },
      visibleWhen: VISIBLE,
      storage: { kind: "scalar" },
      since: "CC-02.2",
      readers: ["services/connect/relay/access.ts"],
    }),
  ],
};
