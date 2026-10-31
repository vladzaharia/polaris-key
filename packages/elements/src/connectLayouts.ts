import type { ConnectScreenName } from "@polaris-key/ui-core";

import type { Layout } from "./layout.js";

/**
 * The inter-account screens (CC-19.9). LinkPairing draws its code, the categories and its controls
 * in `content`, so the categories sit before the confirm button; TransferOffer's controls are the
 * standard ones. The React kit draws both; the elements have no tag for them yet.
 */
export const CONNECT_LAYOUTS: Readonly<Record<ConnectScreenName, Layout>> = {
  LinkPairing: {
    kind: "screen",
    header: "compact",
    controls: [],
    content: [
      "linkPairing.searching",
      "a11y.linkCode",
      "linkPairing.reported",
      "linkPairing.reportedUnnamed",
      "linkPairing.shares",
      "linkPairing.sharesNone",
      "linkPairing.confirm",
      "linkPairing.decline",
      "common.tryAgain",
      "common.cancel",
      "common.done",
    ],
  },
  TransferOffer: {
    kind: "screen",
    header: "compact",
    controls: [
      "transferOffer.accept",
      "transferOffer.decline",
      "common.cancel",
      "common.done",
    ],
  },
};
