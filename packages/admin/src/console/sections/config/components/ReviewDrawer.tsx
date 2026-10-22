import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type ConfigEntry,
  type ProductCatalog,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import type { CatalogIssue } from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
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
import { entryFieldView, typeChangeNotes } from "../model/diffView.js";
import { mergeDraft } from "../model/mergeDraft.js";
import { CATALOG_PATH, useCatalogUsage } from "../data.js";

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
  onFix: (index: number) => void;
  onPublished: (version: number) => void;
  onDiscard: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const diff = React.useMemo(() => draftDiff(draft), [draft]);
  const removedKeys = React.useMemo(
    () => (open ? diff.removed.map((c) => c.key) : []),
    [open, diff],
  );
  const usage = useCatalogUsage(slug, removedKeys);
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
  const typeNotes = React.useMemo(() => typeChangeNotes(diff.changed), [diff]);
  const breaking =
    Object.keys(referencedBy).length > 0 || Object.keys(typeNotes).length > 0;
  const conflict =
    error instanceof ApiError &&
    error.status === 409 &&
    error.reason === "catalog_version_conflict";
  const stale = server !== null && server.schemaVersion !== draft.baseVersion;
  const live = server?.schemaVersion ?? draft.baseVersion;
  const nextVersion = live + 1;
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
      if (err instanceof ApiError && err.status === 409)
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
                            onClick={() => onFix(i.index!)}
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
                <Callout tone="warning" title="This catalog is manifest-owned">
                  Publishing claims it for the console: resyncs from the
                  repository stop re-applying{" "}
                  <code className="font-mono text-xs">{CATALOG_PATH}</code>{" "}
                  until it is reverted to the manifest. Make the same change in
                  the repository to keep the two in step.
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
                <div
                  role="alert"
                  className="space-y-1 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
                >
                  <p className="font-semibold text-danger">
                    Publish didn’t finish
                  </p>
                  <p className="text-fg-strong">{copy.title}</p>
                  <p className="text-fg">{copy.description}</p>
                  {copy.fieldErrors?.length ? (
                    <ul className="mt-1 list-disc ps-5 font-mono text-xs">
                      {copy.fieldErrors.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="text-fg">
                    Devices still get v{live}. Your draft is kept.
                  </p>
                </div>
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
