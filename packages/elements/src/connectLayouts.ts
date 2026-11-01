import type { ConnectScreenName } from "@polaris-key/ui-core";

import type { Layout } from "./layout.js";

/**
 * The inter-account screens (CC-19.9). LinkPairing draws its code, the categories and its controls
 * in `content`, so the categories sit before the confirm button; TransferOffer's controls are the
 * standard ones. The React kit and the elements (`pk-link-pairing`, `pk-transfer-offer`) draw both.
 */
export const CONNECT_LAYOUTS: Readonly<Record<ConnectScreenName, Layout>> = {
  LinkPairing: {
    kind: "screen",
    header: "compact",
    controls: [],
    titles: ["linkPairing.waiting"],
    content: [
      "linkPairing.searching",
      "a11y.linkCode",
      "linkPairing.reported",
      "linkPairing.reportedUnnamed",
      "linkPairing.shares",
      "linkPairing.sharesNone",
      "linkPairing.confirm",
      "linkPairing.decline",
      "core.codes.connect_links_disabled.message",
      "common.tryAgain",
      "common.cancel",
      "common.done",
    ],
  },
  TransferOffer: {
    kind: "screen",
    header: "compact",
    titles: [
      "transferOffer.ask",
      "transferOffer.askUnnamed",
      "transferOffer.receiving",
      "transferOffer.done",
      "transferOffer.failed",
    ],
    controls: [
      "transferOffer.accept",
      "transferOffer.decline",
      "common.cancel",
      "common.done",
    ],
  },
};
