// What only the Cloud Sync screens need (U-42.2): their layouts and their rules in light-DOM form.
// Its own entry (`./sync`): the React kit imports it on demand, with the screens, so the gate's
// entry carries neither.

export { copyForm, recoveryGroups, spokenForm } from "./recoveryCode.js";
export { SYNC_LAYOUTS } from "./syncLayouts.js";

import { scopeCss } from "./scopeCss.js";
import { SYNC_CSS } from "./syncStyles.js";

/** The Cloud Sync screens' part of `lightDomCss()`, to adopt where they are drawn. */
export function lightDomSyncCss(): string {
  return scopeCss(`@layer polaris-key {\n${SYNC_CSS}}\n`);
}
