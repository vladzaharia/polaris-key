/**
 * Where the portal sends a person who is stuck or asked (DOC-06a; docs plan §7.4): the one table
 * of its links into Help. Every value is an absolute `/docs/help/...` path ending in `/`, optionally
 * with a `#anchor`, and every one is public tier (no session needed).
 *
 * Drift gate: `packages/worker/test/portalHelpLinks.test.ts` asserts every path here exists in the
 * built docs site (`packages/docs/dist/docs-slugs.json`) and that each `#anchor` names a heading on
 * its page, the way `docsLinks.test.ts` does for the console. Renaming a Help page means updating
 * this table in the same change.
 *
 * Message anchors are the catalog's message ids (`help-messages.json`): a refusal code links the
 * page that explains it. The link text is catalog copy (`locker.help.*`), never written here.
 */
export const HELP_LINKS = {
  /** The Help door: the account menu and the sign-in card. */
  help: "/docs/help/",
  /** What the site keeps (no privacy-policy or terms page exists yet; D5). */
  privacy: "/docs/help/your-data/",
  /** The sign-in card's code step. */
  codeDidntArrive: "/docs/help/code-didnt-arrive/",
  /** A product's Need help? card when its developer gave no support contact. */
  contact: "/docs/help/contact/",
  /** The Devices card. */
  devices: "/docs/help/devices/",
  /** The empty Library: a purchase made with another email. */
  joinAccounts: "/docs/help/join-accounts/",
  /** Activate refusals, by verdict code. */
  licenseOwned: "/docs/help/add-a-license/#license_owned",
  emailMismatch: "/docs/help/add-a-license/#email_mismatch",
  keyEntryLimit: "/docs/help/add-a-license/#key_entry_limit",
  /** Download refusals the portal words itself (`portal.<code>` message ids). */
  fileNotFound:
    "/docs/help/messages/downloads-and-updates/#portal.file_not_found",
  notHosted: "/docs/help/messages/downloads-and-updates/#portal.not_hosted",
  licenseInactive:
    "/docs/help/messages/downloads-and-updates/#portal.license_inactive",
  /** A download refused for a license that does not cover the file. */
  notEntitled: "/docs/help/messages/license-status/#not_entitled",
} as const;

export type HelpLinkId = keyof typeof HELP_LINKS;

/** The Help page for a refusal code the portal shows, or `undefined` when it has none. */
export function helpForRefusal(code: string | undefined): string | undefined {
  switch (code) {
    case "license_owned":
      return HELP_LINKS.licenseOwned;
    case "email_mismatch":
      return HELP_LINKS.emailMismatch;
    case "entries":
    case "key_entry_limit":
      return HELP_LINKS.keyEntryLimit;
    case "file_not_found":
      return HELP_LINKS.fileNotFound;
    case "not_hosted":
      return HELP_LINKS.notHosted;
    case "license_inactive":
      return HELP_LINKS.licenseInactive;
    case "not_entitled":
      return HELP_LINKS.notEntitled;
    default:
      return undefined;
  }
}
