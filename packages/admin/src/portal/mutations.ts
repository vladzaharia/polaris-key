/**
 * The portal's mutation → invalidation table (the console's twin is
 * `console/data/mutations.ts`; the engine is `lib/writes.ts`).
 *
 * Every `portalApi` method that sends anything but GET has an entry: the queries its confirmed
 * success makes stale, as today's hooks and components make them. `[]` is a decision and `why`
 * says it. `test/portalMutations.test.ts` calls every method against a recording fetch and fails
 * when this table and the writing methods differ.
 *
 * Supersets are deliberate where the arguments cannot name the exact record: one extra refetch is
 * cheap, a stale security fact is not.
 */

import type { QueryClient } from "@tanstack/react-query";
import { createWrites, type Target, type WriteSpec } from "../lib/writes.js";
import { portalApi, PortalApiError } from "./api.js";
import { qk, qkAll, qkFamily } from "./queries.js";

const exact = (key: Target["key"]): Target => ({ key, exact: true });
const prefix = (key: Target["key"]): Target => ({ key });

/** What a changed sign-in method touches : the methods, the session
 *  (its email follows the primary), the profile's sources and the licences waiting on an address. */
const methodChange = (): Target[] => [
  exact(qk.methods()),
  exact(qk.me()),
  exact(qk.profile()),
  exact(qk.library()),
  exact(qk.licenses()),
];

/** Every view that lists a licence of `product` (a removal, a freed seat). */
const licenceViews = (product: string): Target[] => [
  exact(qk.licenses()),
  exact(qk.library()),
  prefix(qk.product(product)),
];

/** Each entry is checked against its method's arguments. */
type Checked = {
  [M in keyof typeof portalApi]?: WriteSpec<Parameters<(typeof portalApi)[M]>>;
};

export const PORTAL_MUTATIONS = {
  // Account
  deleteMe: {
    label: "Schedule the account's deletion",
    invalidates: () => [exact(qk.me())],
  },
  cancelDeletion: {
    label: "Cancel the account's scheduled deletion",
    invalidates: () => [exact(qk.me())],
  },
  updateProfile: {
    label: "Save an explicit profile choice",
    invalidates: () => [],
    why: "The answer is the whole profile: useUpdateProfile writes it into the profile and session caches (a refetch would race it).",
  },
  uploadPicture: {
    label: "Upload a profile picture",
    invalidates: () => [],
    why: "It only stores the blob; the choice that uses it (updateProfile) is what changes the profile.",
  },

  // Sign-in
  startEmailSignIn: {
    label: "Send a sign-in code",
    invalidates: () => [],
    why: "A code is sent; no cached fact changes until it is verified.",
  },
  resendSignInCode: {
    label: "Send the sign-in code again",
    invalidates: () => [],
    why: "A code is sent; no cached fact changes until it is verified.",
  },
  verifySignInCode: {
    label: "Verify the emailed sign-in code",
    invalidates: () => [],
    why: "The status decides (a new address finishes first, signed out): the sign-in card invalidates the session, awaited, once the sign-in is complete.",
  },
  finishPendingSignIn: {
    label: "Finish a sign-in confirmed on another device",
    invalidates: () => [],
    why: "The session read (fetchSession) calls it and is itself the refresh.",
  },
  passkeySignInOptions: {
    label: "Start a passkey sign-in",
    invalidates: () => [],
    why: "A challenge only; nothing is signed in until the passkey is verified.",
  },
  passkeySignInVerify: {
    label: "Sign in, or step up, with a passkey",
    invalidates: () => [],
    why: "The sign-in card invalidates the session, awaited, once the assertion is accepted; a step-up refreshes the session itself (refreshSession).",
  },
  previewKeySignedOut: {
    label: "Preview what a key would do, before anyone signs in",
    invalidates: () => [],
    why: "Read-only and never counted; it is a POST only to keep the key out of the URL.",
  },
  gateChoose: {
    label: "Choose the email for the account-gate step",
    invalidates: () => [],
    why: "Answers the sign-in card's next step; the card invalidates the session once the sign-in is complete.",
  },
  gateVerify: {
    label: "Verify the account-gate code",
    invalidates: () => [],
    why: "Answers the sign-in card's next step; the card invalidates the session once the sign-in is complete.",
  },
  gateJoin: {
    label: "Join the account found at the gate",
    invalidates: () => [],
    why: "Answers the sign-in card's next step; the card invalidates the session once the sign-in is complete.",
  },
  gateCancel: {
    label: "Abandon the account-gate step",
    invalidates: () => [],
    why: "Drops the browser's pending sign-in; the card then re-reads the session itself.",
  },
  deviceLoginStart: {
    label: "Start a sign-in through another device",
    invalidates: () => [],
    why: "A request is opened; the poll (a read) learns when it is approved.",
  },
  deviceLoginLookup: {
    label: "Look up another device's sign-in code",
    invalidates: () => [],
    why: "Shows the request to the approver; this session's data is unaffected.",
  },
  deviceLoginDecide: {
    label: "Approve or deny another device's sign-in",
    invalidates: () => [],
    why: "Acts on another device's session; this session's data is unaffected.",
  },
  signinContinue: {
    label: "Continue an app's sign-in with a license choice",
    invalidates: () => [],
    why: "The app card ends in a redirect to the app; a raced choice re-reads its own license list.",
  },
  signinCancel: {
    label: "Cancel an app's sign-in",
    invalidates: () => [],
    why: "The app card ends in a redirect back to the app.",
  },
  signOutHere: {
    label: 'Sign this browser out ("Not you?")',
    invalidates: () => [],
    // Awaited: the card waits for the session to say what is true.
    settle: () => [exact(qk.me())],
    removes: () => [
      prefix(qkFamily("signinLicenses")),
      prefix(qkFamily("signinConsent")),
    ],
  },
  signOutEverywhere: {
    label: "End every session and app of the account",
    invalidates: () => [],
    why: "The caller leaves the page; the next session read answers 401.",
  },
  endSession: {
    label: "End one other session",
    invalidates: () => [exact(qk.sessions())],
  },

  // Licences, library, products
  claimKey: {
    label: "Add a license key",
    // The arguments do not name the product, so its view and downloads refresh by family.
    invalidates: () => [
      exact(qk.licenses()),
      exact(qk.releases()),
      exact(qk.library()),
      // A key for a product Discover offered takes it off the shelf.
      exact(qk.discover()),
      prefix(qkFamily("product")),
      prefix(qkFamily("downloads")),
    ],
  },
  previewKey: {
    label: "Preview what adding a key would do",
    invalidates: () => [],
    why: "Read-only; it is a POST only to keep the key out of the URL.",
  },
  removeLicense: {
    label: "Remove a license from the library",
    invalidates: (product: string) => [
      ...licenceViews(product),
      exact(qk.releases()),
      exact(qk.discover()),
    ],
    removes: (product: string, licenseId: string) => [
      exact(qk.license(product, licenseId)),
    ],
  },
  disconnectDevice: {
    label: "Free a device's seat",
    invalidates: (product: string, licenseId: string) => [
      prefix(qk.license(product, licenseId)),
      ...licenceViews(product),
    ],
  },
  claimDiscover: {
    label: "Add a Discover product to the library",
    invalidates: (product: string) => [
      exact(qk.licenses()),
      exact(qk.discover()),
      prefix(qk.product(product)),
    ],
    // Resolves only once the library holds the product: the page that moves on to it must not
    // find it missing. The storefront page is left as it is.
    settle: () => [exact(qk.library())],
  },
  removeLibraryEntry: {
    label: "Remove an open product's library entry",
    invalidates: () => [exact(qk.library()), exact(qk.discover())],
    removes: (product: string) => [
      prefix(qk.product(product)),
      prefix(qk.storefront(product)),
    ],
  },
  createSupportCode: {
    label: "Get a support code for a product",
    invalidates: (product: string) => [prefix(qk.product(product))],
  },
  removeProductData: {
    label: "Remove my data from a product",
    // The arguments do not name the licences: every licence view refreshes.
    invalidates: (product: string) => [
      prefix(qkFamily("license")),
      ...licenceViews(product),
      exact(qk.releases()),
      exact(qk.discover()),
    ],
  },
  emailDownload: {
    label: "Email a download link",
    invalidates: () => [],
    why: "Sends an email; nothing cached changes.",
  },
  downloadToken: {
    label: "Mint a fresh download link",
    invalidates: () => [],
    why: "Links are made fresh on every click; nothing cached changes.",
  },

  // Packages
  mintPersonalToken: {
    label: "Mint a personal package token",
    invalidates: () => [exact(qk.personalTokens())],
  },
  revokePersonalToken: {
    label: "Revoke a personal package token",
    invalidates: () => [exact(qk.personalTokens())],
  },
  mintRegistryToken: {
    label: "Mint a license-bound package token",
    invalidates: (product: string, licenseId: string) => [
      exact(qk.registryTokens(product, licenseId)),
      exact(qk.personalTokens()),
    ],
  },
  revokeRegistryToken: {
    label: "Revoke a license-bound package token",
    invalidates: (product: string, licenseId: string) => [
      exact(qk.registryTokens(product, licenseId)),
      exact(qk.personalTokens()),
    ],
  },

  // Linking accounts
  linkStart: {
    label: "Start joining two accounts",
    invalidates: () => [],
    why: "The link view reads this browser's flow fresh on every mount.",
  },
  linkConfirm: {
    label: "Join the two accounts",
    invalidates: () => [...methodChange(), exact(qk.link())],
  },
  linkCancel: {
    label: "Cancel a join in progress",
    invalidates: () => [],
    why: "A teardown the dialog fires and forgets; the link view reads fresh on every mount.",
  },
  linkUndo: {
    label: "Undo a join",
    invalidates: () => [...methodChange(), exact(qk.link())],
  },

  // Sign-in methods
  startProviderMethod: {
    label: "Start connecting a provider",
    invalidates: () => [],
    why: "The browser leaves for the provider; the methods are re-read when it returns.",
  },
  startEmailMethod: {
    label: "Start adding an email (sends a code)",
    invalidates: () => [],
    why: "A code is sent; the method exists only once verified.",
  },
  verifyEmailMethod: {
    label: "Add a verified email",
    invalidates: methodChange,
  },
  passkeyRegistrationOptions: {
    label: "Start adding a passkey",
    invalidates: () => [],
    why: "A challenge only; the passkey exists once addPasskey succeeds.",
  },
  addPasskey: {
    label: "Save a new passkey",
    invalidates: methodChange,
  },
  removeMethod: {
    label: "Disconnect a sign-in method",
    invalidates: methodChange,
  },
  makePrimary: {
    label: "Make a verified email the primary (the answer is the methods list)",
    invalidates: methodChange,
  },
  renamePasskey: {
    label: "Name a passkey",
    invalidates: () => [exact(qk.methods())],
  },
} satisfies Checked;

export type PortalWriteMethod = keyof typeof PORTAL_MUTATIONS;

const writes = createWrites({ table: PORTAL_MUTATIONS, api: portalApi });

export const {
  invalidationFor,
  bindWriteInvalidation,
  invalidateAfter,
  mutate,
  mutateEach,
  useWrite,
} = writes;

/** "Remove" where a 404 means it is gone already (another tab): the same outcome. */
export async function removeLibraryEntryOrGone(product: string) {
  try {
    return await portalApi.removeLibraryEntry(product);
  } catch (err) {
    if (err instanceof PortalApiError && err.status === 404)
      return { ok: true as const, product, inLibrary: false };
    throw err;
  }
}

export async function removeLicenseOrGone(product: string, licenseId: string) {
  try {
    return await portalApi.removeLicense(product, licenseId);
  } catch (err) {
    if (err instanceof PortalApiError && err.status === 404)
      return { ok: true as const, product, licenseId };
    throw err;
  }
}

/**
 * After a step-up sign-in (the same account, a fresh session): what depends on how recently the
 * person signed in is read again. The session itself is read by `refreshSession` (it carries the
 * new CSRF token). The methods and sessions lists were always re-read; the link view and the
 * profile's sources carry the same "proven within 5 minutes" facts. Nothing else is touched.
 */
export async function refreshAfterStepUp(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: qk.methods() }),
    client.invalidateQueries({ queryKey: qk.sessions() }),
    client.invalidateQueries({ queryKey: qk.link() }),
    client.invalidateQueries({ queryKey: qk.profile() }),
  ]);
}

/**
 * Signed in to another account after all: everything on the page belongs to it now. The first
 * account's data is dropped (not merely marked stale), so no entry of it can render while the
 * refetch lands; only the session read survives, to be read again.
 */
export async function refreshAfterAccountChange(
  client: QueryClient,
): Promise<void> {
  await client.cancelQueries({ queryKey: qkAll() });
  client.removeQueries({
    queryKey: qkAll(),
    predicate: (q) => q.queryKey[1] !== "me",
  });
  void client.invalidateQueries({ queryKey: qkAll() });
}
