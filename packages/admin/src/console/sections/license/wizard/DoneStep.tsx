/**
 * New license (LX-29): the result, in place. The keys exist in plaintext only in the response that
 * made them, so this is the one screen that shows them: a single key with its delivery result, or
 * a batch as a CSV built here from that response (nothing is fetched again).
 *
 * The screen holds "the only copy" when the key is shown for the operator to pass on (Show it
 * once), when the email did not go out, and always for a batch. Only then does leaving wait for
 * the key to be kept; after an email that went out the key is shown as a courtesy.
 */

import * as React from "react";
import { Download, FileText } from "lucide-react";
import type {
  InviteOutcome,
  KeyEmailFailure,
  KeyEmailOutcome,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { SecretValue, saveAsFile } from "../../../../ui/OneTimeSecretPanel.js";
import { MomentLine, momentKey } from "../../../components/Moment.js";
import {
  canRetryKeyEmail,
  keyEmailFailureCopy,
} from "../components/SendKeyDialog.js";
import { inviteFailureCopy } from "../components/inviteCopy.js";
import {
  csvOf,
  deliveryOf,
  invitesPerson,
  type CsvRow,
  type Draft,
} from "./draft.js";

export type Result =
  | {
      kind: "single";
      id: string;
      /** Absent for an invitation without "Also create a key". */
      key: string | null;
      /** An invitation was asked for: how it went. Never carries a key. */
      invite: { outcome: InviteOutcome; reason?: KeyEmailFailure } | null;
      /** The address the key or invitation was emailed to, or null when no email was asked for. */
      email: string | null;
      /** The key is on screen (not for "Email the key" alone, unless the email failed). */
      showKey: boolean;
      /** This screen holds the only copy: leaving waits for it to be kept. */
      onlyCopy: boolean;
      delivered: { email: KeyEmailOutcome; reason?: KeyEmailFailure } | null;
      first: boolean;
      /** "Pro · 5 devices · for Lena Ortiz". */
      summary: string;
      /** A later send went out: the email holds a newer key than the one on screen. */
      retried?: boolean;
    }
  | {
      kind: "batch";
      batchId: string;
      label: string;
      rows: CsvRow[];
      first: boolean;
      summary: string;
    };

/** The result of `POST …/licenses` for one assigned or floating license, in the draft's terms. */
export function singleResult(
  res: {
    licenseId: string;
    key?: string;
    delivered?: {
      email?: KeyEmailOutcome;
      invite?: InviteOutcome;
      reason?: KeyEmailFailure;
    };
  },
  draft: Draft,
  first: boolean,
  summary: string,
): Result {
  const invited = invitesPerson(draft);
  const failed = res.delivered?.email === "failed";
  const delivery = deliveryOf(draft);
  const key = res.key ?? null;
  const reason = res.delivered?.reason ? { reason: res.delivered.reason } : {};
  return {
    kind: "single",
    id: res.licenseId,
    key,
    invite: invited
      ? { outcome: res.delivered?.invite ?? "failed", ...reason }
      : null,
    email: draft.who === "person" ? draft.email.trim() : null,
    // "Email the key" alone never shows it, unless the email did not go out. An invitation shows
    // a key only when one was asked for, and never emailed it.
    showKey: key !== null && (invited || delivery !== "email" || failed),
    // Only then is this screen the one copy: Show it once, an email that failed, or a key no
    // email carries.
    onlyCopy: key !== null && (invited || delivery === "show" || failed),
    delivered:
      !invited && res.delivered?.email
        ? { email: res.delivered.email, ...reason }
        : null,
    first,
    summary,
  };
}

/** The step heading: what happened, in the words of the outcome. */
export function doneTitle(result: Result): string {
  if (result.kind === "batch")
    return `${result.rows.length} ${result.rows.length === 1 ? "key" : "keys"} created`;
  if (result.invite)
    return result.invite.outcome === "failed"
      ? "Invitation not sent"
      : "Invitation sent";
  return result.delivered?.email === "failed"
    ? "Key not emailed"
    : "License created";
}

/** Whether leaving waits for the operator to copy, download or tick. */
export function needsKeep(result: Result): boolean {
  return result.kind === "batch" || result.onlyCopy;
}

const clock = (d: Date): string =>
  d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function DoneBody({
  slug,
  productName,
  result,
  kept,
  onKept,
  retrying,
  retryNote,
  retryWait,
  onRetry,
  onTryIt,
}: {
  slug: string;
  productName: string;
  result: Result;
  kept: boolean;
  onKept: (kept: boolean) => void;
  retrying: boolean;
  /** A refusal of Try again, in words. */
  retryNote: React.ReactNode;
  /** Seconds until another send is allowed (0: now). */
  retryWait: number;
  onRetry: () => void;
  onTryIt: () => void;
}): React.ReactElement {
  const [downloadedAt, setDownloadedAt] = React.useState<Date | null>(null);
  const gate = needsKeep(result) && !kept;
  const first = result.first ? (
    <MomentLine
      momentKey={momentKey("first-license", slug)}
      title={`${productName}'s first license`}
      className="space-y-2 rounded-md border border-border bg-surface-raised p-3"
    >
      <span className="block">
        Try it in your app: Integration has the code to install the SDK and pin
        your signing key.
      </span>
      <Button
        size="sm"
        variant="outline"
        disabledReason={
          gate
            ? result.kind === "batch"
              ? "Download or copy the keys first"
              : "Copy the key first"
            : undefined
        }
        onClick={onTryIt}
      >
        Try it
      </Button>
    </MomentLine>
  ) : null;

  if (result.kind === "batch") {
    const keys = result.rows.map((r) => r.key);
    const csv = csvOf(result.rows);
    const name = `${slug}-${
      result.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "keys"
    }.csv`;
    const download = (): void => {
      if (saveAsFile(csv, name, "text/csv")) {
        setDownloadedAt(new Date());
        onKept(true);
      }
    };
    return (
      <div className="space-y-4">
        <Callout tone="warning" title="These keys are shown once" live>
          Download the CSV or copy the keys now. Polaris Key keeps only their
          hashes.
        </Callout>
        <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
          <FileText aria-hidden className="size-5 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium [overflow-wrap:anywhere] text-fg-strong">
              {name}
            </p>
            <p className="text-xs text-fg-muted">
              {result.rows.length} rows · {sizeText(csv.length)}
              {downloadedAt ? ` · Downloaded at ${clock(downloadedAt)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={kept ? "outline" : "primary"}
            iconStart={<Download aria-hidden />}
            onClick={download}
          >
            {downloadedAt ? "Download again" : "Download CSV"}
          </Button>
          <CopyButton
            value={keys.join("\n")}
            label="Copy all keys"
            text="Copy all"
            size="md"
            showLabel
            onCopy={(ok) => ok && onKept(true)}
          />
        </div>
        <label className="flex min-h-6 items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={kept}
            onChange={(e) => onKept(e.target.checked)}
            className="size-4 accent-(--pk-accent)"
          />
          I&apos;ve stored them
        </label>
        {first}
      </div>
    );
  }

  const inviteFailed = result.invite?.outcome === "failed";
  const failed = result.delivered?.email === "failed" || inviteFailed;
  const retryReason = !kept
    ? "Tick “I've stored it” first."
    : retryWait > 0
      ? `Try again in ${Math.max(1, Math.ceil(retryWait / 60))} min.`
      : null;
  return (
    <div className="space-y-4">
      {result.invite && !inviteFailed ? (
        <Callout tone="success" live>
          Invitation sent to {result.email}.
        </Callout>
      ) : null}
      {result.invite && inviteFailed ? (
        <Callout tone="warning" title="The invitation wasn't sent" live>
          {inviteFailureCopy(result.invite.reason, result.email ?? "")}
        </Callout>
      ) : null}
      {result.delivered && !failed ? (
        <Callout tone="success" live>
          Emailed to {result.email}.
        </Callout>
      ) : null}
      {result.delivered?.email === "failed" ? (
        <Callout tone="warning" live>
          {keyEmailFailureCopy(result.delivered?.reason, result.email ?? "")}
        </Callout>
      ) : null}
      {retryNote}
      {result.showKey && result.key !== null ? (
        <SecretValue
          label="License key"
          value={result.key}
          hint={
            result.invite
              ? "Shown once. It isn't in the invitation. Copy it now."
              : result.onlyCopy
                ? "Shown once. Copy it now."
                : result.retried
                  ? "Their email has a newer key. This one works too."
                  : "Shown once. It is in their email too."
          }
          hideAck={!result.onlyCopy}
          acknowledged={kept}
          onAcknowledgedChange={onKept}
        />
      ) : null}
      {failed &&
      canRetryKeyEmail(
        result.invite ? result.invite.reason : result.delivered?.reason,
      ) ? (
        <div className="space-y-1">
          <Button
            variant="outline"
            loading={retrying}
            disabled={retryReason !== null}
            aria-describedby="new-license-retry-note"
            onClick={onRetry}
          >
            Try again
          </Button>
          <p id="new-license-retry-note" className="text-xs text-fg-muted">
            {retryReason ??
              (result.invite
                ? "Sends the invitation again."
                : "Emails another new key. This one keeps working.")}
          </p>
        </div>
      ) : null}
      {first}
    </div>
  );
}
