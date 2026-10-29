import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HttpError,
  type ConfigEntry,
  type ProductCatalog,
} from "../../../../api.js";
import { cloudSyncEncryption } from "@polaris-key/catalog";
import { lineDiff } from "../../../../lib/diff.js";
import {
  ENCRYPTION_LABEL,
  encryptionChangeCopy,
} from "../../../../lib/encryption.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import type { CatalogIssue } from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { CopyDetails } from "../../../../ui/CopyDetails.js";
import { Section } from "../../../../ui/Section.js";
import { DiffViewer } from "../../../../ui/DiffViewer.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { BREAK_GLASS_REASON_MAX } from "../../../components/BreakGlassDialog.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import {
  draftDiff,
  draftDocument,
  draftEntries,
  type CatalogDraft,
} from "../model/catalogDraft.js";
import {
  entryFieldView,
  publishCause,
  typeChangeNotes,
} from "../model/diffView.js";
import { mergeDraft } from "../model/mergeDraft.js";
import { CATALOG_PATH, useCatalogUsage } from "../data.js";
import { syncUsageQuery } from "../../sync/data.js";

/**
 * The review step behind "Review changes" (docs/design/mockups config.catalog-review and
 * config.catalog-review-states; D9: a drawer): the draft against the published version as a
 * per-entry diff, who a removal reaches, and Publish as the one primary. Its other states:
 *
 * - **Nothing to publish:** the draft matches the published version; Publish stays, disabled and
 *   described by the sentence.
 * - **A validation error:** shown at its entry with a way to it, never a toast; Publish waits.
 * - **A failed publish:** a danger callout says what failed and that nothing changed; the draft is
 *   kept and the primary reads "Publish version N again".
 */
export function ReviewDrawer({
  slug,
  open,
  onOpenChange,
  draft,
  setDraft,
  server,
  source,
  authoritative,
  issues,
  holdReason,
  onFix,
  onPublished,
  onDiscard,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: CatalogDraft;
  setDraft: (next: CatalogDraft) => void;
  server: ProductCatalog | null;
  source: "manifest" | "admin";
  authoritative: boolean;
  /** The draft's validation errors. */
  issues: CatalogIssue[];
  /** Why Publish waits for something other than an error or a missing acknowledgement. */
  holdReason?: string;
  /** Close the review and open the entry at this position. */
  onFix: (index: number, field?: string) => void;
  onPublished: (version: number) => void;
  onDiscard: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const diff = React.useMemo(() => draftDiff(draft), [draft]);
  const removedKeys = React.useMemo(
    () => (open ? diff.removed.map((c) => c.key) : []),
    [open, diff],
  );
  // Usage is read for every changed key: the rail counts who sets any of them, and a removal's
  // references come from the same read.
  const touchedKeys = React.useMemo(
    () => (open ? [...diff.removed, ...diff.changed].map((c) => c.key) : []),
    [open, diff],
  );
  const usage = useCatalogUsage(slug, touchedKeys);
  const [ack, setAck] = React.useState(false);
  // ST-20: a manifest-authoritative product's publish is a break-glass claim with a reason (L2).
  const [reason, setReason] = React.useState("");
  const reasonId = React.useId();
  const [publishing, setPublishing] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (!open) {
      setAck(false);
      setReason("");
      setError(null);
    }
  }, [open]);

  const referencedBy: Record<string, string[]> = {};
  const profilesAffected = new Set<string>();
  for (const key of removedKeys) {
    const u = usage.data?.keys[key];
    if (!u) continue;
    const refs = [
      ...u.profiles.map((p) => `profile ${p.id}`),
      ...u.licenses.map((l) => `license ${l.name || l.id}`),
      ...(u.accounts ?? []).map((a) => `account ${a.subject}`),
    ];
    for (const p of u.profiles) profilesAffected.add(p.id);
    if (refs.length) referencedBy[key] = refs;
  }
  const reach = React.useMemo(() => {
    const profiles = new Set<string>();
    const licenses = new Set<string>();
    const accounts = new Set<string>();
    for (const key of touchedKeys) {
      const u = usage.data?.keys[key];
      if (!u) continue;
      for (const p of u.profiles) profiles.add(p.id);
      for (const l of u.licenses) licenses.add(l.id);
      for (const a of u.accounts ?? []) accounts.add(a.subject);
    }
    return {
      profiles: profiles.size,
      licenses: licenses.size,
      accounts: accounts.size,
    };
  }, [touchedKeys, usage.data]);
  const diffText = React.useMemo(
    () =>
      lineDiff(
        JSON.stringify(
          { schemaVersion: draft.baseVersion, entries: draft.baseEntries },
          null,
          2,
        ),
        JSON.stringify(draftDocument(draft), null, 2),
      )
        .filter((row) => row.kind !== "context")
        .map((row) => `${row.kind === "added" ? "+" : "-"} ${row.text}`)
        .join("\n"),
    [draft],
  );
  const typeNotes = React.useMemo(() => typeChangeNotes(diff.changed), [diff]);
  const breaking =
    Object.keys(referencedBy).length > 0 || Object.keys(typeNotes).length > 0;
  const conflict =
    error instanceof HttpError &&
    error.status === 409 &&
    error.reason === "catalog_version_conflict";
  const stale = server !== null && server.schemaVersion !== draft.baseVersion;
  const live = server?.schemaVersion ?? draft.baseVersion;
  const nextVersion = live + 1;
  // A publish carries the active catalog's Cloud Sync block forward, so encryption changes when
  // the draft started from a version that had the other mode. The notice is for a product that
  // has synced data (or whose usage cannot be read, where it errs toward saying so).
  const encryptionTo = server ? cloudSyncEncryption(server) : null;
  const encryptionDiffers =
    encryptionTo !== null &&
    draft.baseEncryption !== undefined &&
    draft.baseEncryption !== encryptionTo;
  const syncUsage = useQuery({
    ...syncUsageQuery(slug),
    enabled: open && encryptionDiffers,
  });
  const encryptionChanged =
    open &&
    encryptionDiffers &&
    !syncUsage.isPending &&
    syncUsage.data?.enabled !== false &&
    (syncUsage.data?.enabled !== true || syncUsage.data.usage.people > 0);
  const empty = diff.all.length === 0;
  const hasIssues = issues.length > 0;

  const publish = async (): Promise<void> => {
    setPublishing(true);
    setError(null);
    try {
      const res = await mutate(
        "publishSchema",
        slug,
        draftDocument(draft),
        draft.baseVersion,
        authoritative ? { reason: reason.trim() } : undefined,
      );
      onOpenChange(false);
      onPublished(res.schemaVersion);
    } catch (err) {
      setError(err);
      if (err instanceof HttpError && err.status === 409)
        void queryClient.invalidateQueries({ queryKey: qk.catalog(slug) });
    } finally {
      setPublishing(false);
    }
  };

  const copy =
    error && !conflict ? errorCopy(error, { thing: "Catalog" }) : null;
  const gate = (() => {
    if (hasIssues) return "Fix the errors in the draft first.";
    if (empty) return `Draft v${nextVersion} matches v${live}.`;
    if (holdReason) return holdReason;
    if (breaking && !ack) return "Confirm the breaking changes.";
    if (authoritative && reason.trim() === "")
      return "Give a reason for the break-glass claim.";
    if (usage.isFetching) return "Checking the removed keys…";
    return undefined;
  })();

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!publishing}
      size="lg"
      title={
        stale || conflict
          ? "The catalog changed since you started"
          : `Publish version ${nextVersion}`
      }
      description={
        stale || conflict ? undefined : `Against v${live}, as published`
      }
    >
      <DrawerBody>
        <div className="space-y-6">
          {encryptionChanged && encryptionTo && draft.baseEncryption ? (
            <Callout tone="warning" title="Encryption changes" live>
              Cloud Sync goes from {ENCRYPTION_LABEL[draft.baseEncryption]} to{" "}
              {ENCRYPTION_LABEL[encryptionTo]}.{" "}
              {encryptionChangeCopy(encryptionTo)}
            </Callout>
          ) : null}
          {(stale || conflict) && server ? (
            <section className="space-y-3" aria-label="Changes on the server">
              <Callout tone="warning" live>
                v{server.schemaVersion} was published after you started from v
                {draft.baseVersion}. These are its changes. Review your draft
                against it to merge them in, or discard your draft.
              </Callout>
              <DiffViewer<ConfigEntry>
                mode="structured"
                before={draft.baseEntries}
                after={server.entries}
                entryKey="key"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setError(null);
                    const merged = mergeDraft(draft, server);
                    setDraft(merged);
                    // Conflicts are settled in the editor, where both sides are shown.
                    if (merged.conflicts.length > 0) onOpenChange(false);
                  }}
                >
                  Review my draft against v{server.schemaVersion}
                </Button>
                <Button variant="ghost" onClick={onDiscard}>
                  Discard my draft
                </Button>
              </div>
            </section>
          ) : (
            <>
              {empty && !hasIssues ? (
                <section
                  aria-label="Nothing to publish"
                  className="space-y-1 rounded-lg border border-border p-4"
                >
                  <h3 className="text-sm font-semibold text-fg-strong">
                    Nothing to publish
                  </h3>
                  <p className="text-sm text-fg-muted">
                    Draft v{nextVersion} matches v{live}.
                  </p>
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => onOpenChange(false)}
                    >
                      Back to editing
                    </Button>
                    <Button variant="ghost" onClick={onDiscard}>
                      Discard draft
                    </Button>
                  </div>
                </section>
              ) : null}
              {hasIssues ? (
                <section
                  aria-label="Errors in the draft"
                  className="space-y-2 rounded-lg border border-danger-border bg-danger-subtle p-4"
                >
                  <h3 className="text-sm font-semibold text-danger">
                    {issues.length === 1
                      ? "1 error stops the publish"
                      : `${issues.length} errors stop the publish`}
                  </h3>
                  <ul className="space-y-2">
                    {issues.map((i, n) => (
                      <li
                        key={`${i.index}:${i.field}:${n}`}
                        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
                      >
                        {i.key ? (
                          <code className="font-mono text-xs text-fg-strong">
                            {i.key}
                          </code>
                        ) : null}
                        <span className="min-w-0 flex-1 text-fg">
                          {i.message}
                        </span>
                        {i.index !== undefined ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => onFix(i.index!, i.field)}
                          >
                            Fix it
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {empty ? null : (
                <DiffViewer<ConfigEntry>
                  mode="structured"
                  before={draft.baseEntries}
                  after={draftEntries(draft)}
                  entryKey="key"
                  referencedBy={referencedBy}
                  fieldView={entryFieldView}
                  breakingChanged={typeNotes}
                />
              )}
              {empty ? null : (
                <Section
                  variant="settings"
                  id="who-it-reaches"
                  title="Who it reaches"
                  headingLevel={3}
                >
                  <ul className="divide-y divide-border text-sm">
                    {(
                      [
                        ["Profiles", reach.profiles, "set a changed key"],
                        ["Licenses", reach.licenses, "set their own"],
                        ["Accounts", reach.accounts, "set their own"],
                      ] as const
                    )
                      .filter(([, n]) => n > 0)
                      .map(([label, n, what]) => (
                        <li
                          key={label}
                          className="flex items-center justify-between gap-3 px-4 py-3"
                        >
                          <span>{label}</span>
                          <span className="text-fg-muted">
                            {n} {what}
                          </span>
                        </li>
                      ))}
                    <li className="px-4 py-3 text-fg-muted">
                      Devices get v{nextVersion} at their next check.
                    </li>
                  </ul>
                </Section>
              )}
              {usage.isFetching ? (
                <p className="text-sm text-fg-muted">
                  Checking what still uses the removed keys…
                </p>
              ) : null}
              {usage.error ? (
                <ErrorState
                  compact
                  error={usage.error}
                  onRetry={() => void usage.refetch()}
                />
              ) : null}
              {authoritative ? (
                <Callout
                  tone="danger"
                  title="Publishing is a break-glass claim"
                >
                  <p>
                    This product is manifest-authoritative:{" "}
                    <code className="font-mono text-xs">{CATALOG_PATH}</code> is
                    the only writer of its catalog. The published version holds
                    for 7 days, or until the first resync that changes the
                    catalog in the repository, whichever comes first. Commit the
                    change to keep it.
                  </p>
                  <div className="mt-3 space-y-1">
                    <label
                      htmlFor={reasonId}
                      className="text-sm font-medium text-fg-strong"
                    >
                      Reason
                    </label>
                    <Textarea
                      id={reasonId}
                      value={reason}
                      maxLength={BREAK_GLASS_REASON_MAX}
                      required
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                </Callout>
              ) : source === "manifest" && !empty ? (
                <Callout
                  tone="warning"
                  title="This catalog is manifest-owned"
                  action={
                    <CopyButton
                      value={diffText}
                      label="Copy the diff"
                      text="Copy the diff"
                      showLabel
                    />
                  }
                >
                  Publishing takes the catalog over from{" "}
                  <code className="font-mono text-xs">{CATALOG_PATH}</code>;
                  resyncs stop until you revert. Make the same change in the
                  repository.
                </Callout>
              ) : null}
              {breaking ? (
                <Checkbox
                  label={
                    Object.keys(typeNotes).length > 0 &&
                    Object.keys(referencedBy).length === 0
                      ? "I understand a changed Type changes how the app reads the key"
                      : `I understand removed keys are dropped from ${profilesAffected.size} ${profilesAffected.size === 1 ? "profile's" : "profiles'"} payloads and the licenses and accounts listed above`
                  }
                  checked={ack}
                  onCheckedChange={setAck}
                />
              ) : null}
              {copy ? (
                <Callout
                  tone="danger"
                  alert
                  title="Publish didn't finish"
                  action={<CopyDetails copy={copy} always />}
                >
                  <p>{publishCause(error, copy)}</p>
                  {copy.fieldErrors?.length ? (
                    <ul className="mt-1 list-disc ps-5 font-mono text-xs">
                      {copy.fieldErrors.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-1">
                    Devices still get v{live}. Your draft is kept.
                  </p>
                </Callout>
              ) : null}
            </>
          )}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button
          variant="ghost"
          disabled={publishing}
          onClick={() => onOpenChange(false)}
        >
          Back to editing
        </Button>
        {stale || conflict ? null : (
          <Button
            variant={breaking || authoritative ? "danger" : "primary"}
            loading={publishing}
            disabledReason={gate}
            onClick={() => void publish()}
          >
            {copy
              ? `Publish version ${nextVersion} again`
              : `Publish version ${nextVersion}`}
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
