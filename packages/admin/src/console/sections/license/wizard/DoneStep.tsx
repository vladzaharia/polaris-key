/**
 * New license (LX-29): the result, in place. The keys exist in plaintext only in the response that
 * made them, so this is the one screen that shows them: a single key with its delivery result, or
 * a batch as a CSV built here from that response (nothing is fetched again).
 */

import * as React from "react";
import { Download } from "lucide-react";
import type { KeyEmailFailure, KeyEmailOutcome } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { SecretValue, saveAsFile } from "../../../../ui/OneTimeSecretPanel.js";
import { MomentLine, momentKey } from "../../../components/Moment.js";
import {
  canRetryKeyEmail,
  keyEmailFailureCopy,
} from "../components/SendKeyDialog.js";
import { csvOf, type CsvRow } from "./draft.js";

export type Result =
  | {
      kind: "single";
      id: string;
      key: string;
      /** The address the key was emailed to, or null when no email was asked for. */
      email: string | null;
      /** The key is on screen (not for "Email the key" alone, unless the email failed). */
      showKey: boolean;
      delivered: { email: KeyEmailOutcome; reason?: KeyEmailFailure } | null;
      first: boolean;
    }
  | {
      kind: "batch";
      batchId: string;
      label: string;
      rows: CsvRow[];
      first: boolean;
    };

/** The step heading: what happened, in the words of the outcome. */
export function doneTitle(result: Result): string {
  if (result.kind === "batch")
    return `${result.rows.length} ${result.rows.length === 1 ? "key" : "keys"} created`;
  return result.delivered?.email === "failed"
    ? "Key not emailed"
    : "License created";
}

/** Whether the operator still has to copy, download or tick before leaving. */
export function needsKeep(result: Result): boolean {
  return result.kind === "batch" || result.showKey;
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
}): React.ReactElement {
  const first = result.first ? (
    <MomentLine
      momentKey={momentKey("first-license", slug)}
      title={`${productName}'s first license`}
      className="rounded-md border border-border bg-surface-raised p-3"
    >
      Try it in your app: the SDK quick start on Overview installs the SDK and
      pins your signing key.
    </MomentLine>
  ) : null;

  if (result.kind === "batch") {
    const keys = result.rows.map((r) => r.key);
    const download = (): void => {
      const name = result.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      if (
        saveAsFile(
          csvOf(result.rows),
          `${slug}-${name || "keys"}.csv`,
          "text/csv",
        )
      )
        onKept(true);
    };
    return (
      <div className="space-y-4">
        <Callout tone="success" title={result.label}>
          Shown once. Download them or copy them now.
        </Callout>
        <div className="flex flex-wrap items-center gap-2">
          <Button iconStart={<Download aria-hidden />} onClick={download}>
            Download CSV
          </Button>
          <CopyButton
            value={keys.join("\n")}
            label="Copy all keys"
            showLabel
            onCopy={(ok) => ok && onKept(true)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-fg">
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

  const failed = result.delivered?.email === "failed";
  return (
    <div className="space-y-4">
      {result.delivered && !failed ? (
        <Callout tone="success" live>
          Emailed to {result.email}.
        </Callout>
      ) : null}
      {failed ? (
        <Callout tone="warning" live>
          {keyEmailFailureCopy(result.delivered?.reason, result.email ?? "")}
        </Callout>
      ) : null}
      {retryNote}
      {result.showKey ? (
        <SecretValue
          label="License key"
          value={result.key}
          hint="Shown once. Copy it now."
          acknowledged={kept}
          onAcknowledgedChange={onKept}
        />
      ) : null}
      {failed && canRetryKeyEmail(result.delivered?.reason) ? (
        <div className="space-y-1">
          <Button
            variant="outline"
            loading={retrying}
            disabledReason={
              !kept
                ? "Tick “I've stored it” first"
                : retryWait > 0
                  ? `Try again in ${Math.max(1, Math.ceil(retryWait / 60))} min`
                  : undefined
            }
            onClick={onRetry}
          >
            Try again
          </Button>
          <p className="text-xs text-fg-muted">
            Emails another new key. This one keeps working.
          </p>
        </div>
      ) : null}
      {first}
    </div>
  );
}
