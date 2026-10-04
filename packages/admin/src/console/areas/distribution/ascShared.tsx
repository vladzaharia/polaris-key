/**
 * What the App Store pages share (A-17g): Distribution → App Store (the Distribute flow) and
 * Distribution → Commerce (App Store products).
 *
 * - `AscActionDialog` sends one App Store Connect write (or a short sequence of them) at its
 *   ADMIN.md §5.2 level. Every write carries an `Idempotency-Key`, made when the dialog opens and
 *   kept while it stays open: the Worker's ledger answers a retry from what it already did, so a
 *   refusal or a lost connection halfway through resumes instead of repeating (notes/S-14 §7.3).
 * - The L3 writes (submit for review, release, completing a phased release, an In-App Purchase
 *   price change or availability) are typed: the dialog asks for the app's name as App Store
 *   Connect shows it and sends it as `confirm`. The console does not know the name; the Worker
 *   compares it with Apple's before anything is sent.
 * - `ASC_LINKS` are the App Store Connect pages a step deep-links to for what the API cannot do.
 * - `releaseNotesSeed` is where the release-notes step gets its starting text (the seam A-18b's
 *   shared listing model replaces).
 */

import * as React from "react";
import { ExternalLink } from "lucide-react";
import type { AscBuildDto, ConnectorStatusDto } from "../../../api.js";
import { confirmFor, type ActionId } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { humanize, type Tone } from "../../../lib/status.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";

export const describeAsc = (e: unknown) =>
  errorCopy(e, { area: "distribution", thing: "App Store Connect" });

/** The App Store Connect connector of a product, when it has one. */
export function ascConnector(
  connectors: ConnectorStatusDto[] | undefined,
): ConnectorStatusDto | null {
  return connectors?.find((c) => c.kind === "asc") ?? null;
}

/** Why the App Store pages are read-only, or `null` when they can act. */
export function ascBlocked(c: ConnectorStatusDto | null): string | null {
  if (!c)
    return "This product has no App Store Connect connector. Declare an App Store outlet in .pkey/distribution.";
  if (c.inert) return c.inert.message.replace(/^\w/, (x) => x.toUpperCase());
  if (!c.configured)
    return "App Store Connect isn't configured for this product. Set its key in Outlet credentials.";
  return null;
}

/** The pinned app's App Store Connect id, from the connector's setup. */
export function appleIdOf(c: ConnectorStatusDto | null): string | null {
  const v = c?.setup?.appleId;
  return typeof v === "string" && v !== "" ? v : null;
}

/** An Apple enum (`READY_FOR_SALE`) in words ("Ready for sale"). */
export function appleWords(state: string | null | undefined): string {
  return state ? humanize(state.toLowerCase()) : "Unknown";
}

const TONES: Record<string, Tone> = {
  VALID: "success",
  READY_FOR_SALE: "success",
  READY_FOR_DISTRIBUTION: "success",
  APPROVED: "success",
  COMPLETE: "success",
  ACCEPTED: "success",
  READY_TO_SUBMIT: "info",
  READY_FOR_REVIEW: "info",
  WAITING_FOR_REVIEW: "info",
  IN_REVIEW: "info",
  PENDING_DEVELOPER_RELEASE: "accent",
  PENDING_APPLE_RELEASE: "info",
  PROCESSING_FOR_DISTRIBUTION: "info",
  PROCESSING: "info",
  ACTIVE: "accent",
  PREPARE_FOR_SUBMISSION: "neutral",
  INACTIVE: "neutral",
  PAUSED: "warning",
  MISSING_METADATA: "warning",
  DEVELOPER_ACTION_NEEDED: "warning",
  UNRESOLVED_ISSUES: "warning",
  METADATA_REJECTED: "danger",
  REJECTED: "danger",
  INVALID_BINARY: "danger",
  DEVELOPER_REJECTED: "warning",
  INVALID: "danger",
  FAILED: "danger",
  CANCELING: "neutral",
  // TestFlight build states.
  IN_BETA_TESTING: "success",
  BETA_APPROVED: "success",
  READY_FOR_BETA_TESTING: "success",
  READY_FOR_BETA_SUBMISSION: "info",
  WAITING_FOR_BETA_REVIEW: "info",
  IN_BETA_REVIEW: "info",
  IN_EXPORT_COMPLIANCE_REVIEW: "info",
  MISSING_EXPORT_COMPLIANCE: "warning",
  BETA_REJECTED: "danger",
  EXPIRED: "neutral",
};

/** The pill tone of an Apple state; unknown states are neutral. */
export function appleTone(state: string | null | undefined): Tone {
  return (state && TONES[state]) || "neutral";
}

/** A build as the operator names it: "1.2.0 (45)". */
export function buildLabel(b: AscBuildDto): string {
  const v = b.version ?? "?";
  return b.buildNumber ? `${v} (${b.buildNumber})` : v;
}

export const PLATFORM_LABEL: Record<string, string> = {
  IOS: "iOS",
  MAC_OS: "macOS",
  TV_OS: "tvOS",
  VISION_OS: "visionOS",
};

// ── Deep links ────────────────────────────────────────────────────────────────────────────────

/**
 * App Store Connect pages for the steps the API cannot do (Apple documents none of these shapes;
 * notes/S-14 §11). One table, so a moved page is a one-line fix.
 */
export const ASC_LINKS = {
  app: (appleId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/distribution`,
  appInformation: (appleId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/distribution/info`,
  appPrivacy: (appleId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/distribution/privacy`,
  pricing: (appleId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/distribution/pricing`,
  testInformation: (appleId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/testflight/test-info`,
  inAppPurchases: (appleId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/distribution/iaps`,
  inAppPurchase: (appleId: string, iapId: string) =>
    `https://appstoreconnect.apple.com/apps/${appleId}/distribution/iaps/${iapId}`,
} as const;

/** An external App Store Connect link: new tab, with the external glyph. */
export function AscLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-accent-fg underline underline-offset-4"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> (opens App Store Connect)</span>
    </a>
  );
}

// ── Release notes ─────────────────────────────────────────────────────────────────────────────

/** One locale's release notes ("What's New"; TestFlight's "What to Test"). */
export interface LocaleNotes {
  locale: string;
  text: string;
}

/** Apple's limit for What's New and What to Test. */
export const WHATS_NEW_MAX = 4000;

/**
 * The starting release notes for a build, per locale.
 *
 * THE SEAM FOR A-18b (notes/S-15 §5.5, §7.5): the shared listing model keeps per-release,
 * per-locale store notes (`dist_listing_release_notes`), the same notes every store reads. When
 * A-18b lands, this reads them for `releaseId` and the step saves its edits back to the model.
 * Until then the console has no per-locale notes to start from, so each step starts with one empty
 * row in the app's primary language and the operator writes the notes here.
 */
export function releaseNotesSeed(_releaseId: string | null): LocaleNotes[] {
  return [{ locale: "en-US", text: "" }];
}

const LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

/** Why a set of notes cannot be sent, or `null`. */
export function notesError(notes: LocaleNotes[]): string | null {
  if (notes.length === 0) return "Add at least one locale.";
  const seen = new Set<string>();
  for (const n of notes) {
    if (!LOCALE.test(n.locale.trim()))
      return `"${n.locale}" isn't a locale code such as en-US.`;
    if (seen.has(n.locale.trim())) return `${n.locale} appears twice.`;
    seen.add(n.locale.trim());
    if (n.text.trim() === "") return `Write the ${n.locale} notes.`;
    if (n.text.length > WHATS_NEW_MAX)
      return `The ${n.locale} notes are longer than ${WHATS_NEW_MAX} characters.`;
  }
  return null;
}

// ── The write dialog ──────────────────────────────────────────────────────────────────────────

/** One App Store Connect write, confirmed at its §5.2 level. */
export interface AscIntent {
  action: ActionId;
  /** The control's path under `…/connectors/asc/`. */
  control: string;
  title: string;
  consequences: string[];
  confirmLabel: string;
  /** One body, or several sent in order under the one key (one per locale). */
  body: Record<string, unknown> | Record<string, unknown>[];
  /** The success toast. */
  done: string;
  /** Called with every answer once the last one succeeds. */
  onDone?: (results: Record<string, unknown>[]) => void;
}

/** A per-intent key: random, never stored. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The confirmation for one App Store Connect write. L3 intents get an **App name** field; the
 * typed name goes as `confirm` and the confirm button stays disabled until something is typed.
 * The dialog stays open on a refusal and shows it inline; confirming again retries under the same
 * key.
 */
export function AscActionDialog({
  slug,
  intent,
  onClose,
  children,
  confirmDisabled = false,
  bodyExtra,
}: {
  slug: string;
  intent: AscIntent | null;
  onClose: () => void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
  /** Fields the dialog's own inputs add to every body at confirm time. */
  bodyExtra?: () => Record<string, unknown>;
}): React.ReactElement | null {
  const [appName, setAppName] = React.useState("");
  // One key per opened intent: a retry in the same dialog resumes the same ledger steps.
  const key = React.useMemo(
    () => (intent ? newIdempotencyKey() : ""),
    [intent],
  );
  React.useEffect(() => setAppName(""), [intent]);
  if (!intent) return null;
  const policy = confirmFor(intent.action);
  const typed = policy.typed === "appName";
  const bodies = Array.isArray(intent.body) ? intent.body : [intent.body];
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      intent={policy.intent === "none" ? "neutral" : policy.intent}
      title={intent.title}
      consequences={intent.consequences}
      confirmLabel={intent.confirmLabel}
      confirmDisabled={confirmDisabled || (typed && appName.trim() === "")}
      describeError={describeAsc}
      onConfirm={async () => {
        const results: Record<string, unknown>[] = [];
        for (const body of bodies) {
          results.push(
            await mutate(
              "connectorControl",
              slug,
              "asc",
              intent.control,
              {
                ...body,
                ...(bodyExtra?.() ?? {}),
                ...(typed ? { confirm: appName.trim() } : {}),
              },
              { idempotencyKey: key },
            ),
          );
        }
        toast.success(intent.done);
        intent.onDone?.(results);
        onClose();
      }}
    >
      {children}
      {typed ? (
        <FormField<string>
          name="asc-app-name"
          label="App name"
          required
          help="Type the app's name exactly as App Store Connect shows it. Polaris Key checks it against App Store Connect before sending anything."
          value={appName}
          onChange={setAppName}
        >
          {(field) => (
            <Input
              id={field.id}
              value={appName}
              autoComplete="off"
              spellCheck={false}
              onValueChange={setAppName}
              aria-describedby={field["aria-describedby"]}
            />
          )}
        </FormField>
      ) : null}
    </ConfirmDialog>
  );
}
