// The kit's one link validator (UI-KITS DL14); it lives in ui-core's browser module, which the
// elements kit shares.
export { openLink, safeLink } from "@polaris-key/ui-core/browser";

/** The page the person is on: the return address a manage link carries. */
export function currentPageUrl(): string {
  return window.location.href;
}
