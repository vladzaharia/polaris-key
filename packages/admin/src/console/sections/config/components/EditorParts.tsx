import { focusAfterSettle } from "./focusField.js";
import * as React from "react";
import { GitMerge, Lock, SlidersHorizontal, Stamp } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { catalogDiagnostics } from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { CodeEditor } from "../../../../ui/CodeEditor.js";
import { useWriteLock } from "../../../../ui/WriteLock.js";
import { ENTRY_TYPE_LABELS, type EntryType } from "./entryType.js";
import { draftDocument, type CatalogDraft } from "../model/catalogDraft.js";
import { WHOLE_ENTRY, type EntryConflict } from "../model/mergeDraft.js";

const TYPE_GLYPH = {
  setting: SlidersHorizontal,
  secret: Lock,
  minted: Stamp,
  flag: SlidersHorizontal,
} as const;

export function TypeGlyph({ type }: { type: EntryType }): React.ReactElement {
  const Icon = TYPE_GLYPH[type];
  return (
    <span className="shrink-0 text-fg-muted">
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{ENTRY_TYPE_LABELS[type]}: </span>
    </span>
  );
}

// ── JSON mode (CAT-4) ──────────────────────────────────────────────────────────────────────────

export function JsonMode({
  draft,
  setDraft,
}: {
  draft: CatalogDraft;
  setDraft: (next: CatalogDraft) => void;
}): React.ReactElement {
  const serialised = React.useMemo(
    () => `${JSON.stringify(draftDocument(draft), null, 2)}\n`,
    [draft],
  );
  const [text, setText] = React.useState(serialised);
  const emitted = React.useRef(serialised);
  // Follow the draft when it changes from outside (Undo, a discard), never on our own echo.
  React.useEffect(() => {
    if (serialised === emitted.current) return;
    emitted.current = serialised;
    setText(serialised);
  }, [serialised]);

  const labelId = React.useId();
  const { locked } = useWriteLock();
  return (
    <div className="space-y-2">
      <p id={labelId} className="sr-only">
        The whole catalog as JSON. Changes apply to the draft while the text is
        valid JSON with an entries array; the version is assigned when you
        publish.
      </p>
      <CodeEditor
        language="json"
        value={text}
        formattable
        heightClass="h-[32rem]"
        aria-labelledby={labelId}
        validate={catalogDiagnostics}
        readOnly={locked}
        onChange={(next) => {
          setText(next);
          try {
            const doc = JSON.parse(next) as { entries?: unknown };
            if (Array.isArray(doc.entries)) {
              const updated = {
                ...draft,
                entries: doc.entries as ConfigEntry[],
              };
              emitted.current = `${JSON.stringify(draftDocument(updated), null, 2)}\n`;
              setDraft(updated);
            }
          } catch {
            // Not JSON yet: the linter marks it; the draft keeps its last good state.
          }
        }}
      />
    </div>
  );
}

// ── a repository change that meets the draft's own edit (admin-2-21) ───────────────────────────

const sideText = (v: unknown): string =>
  v === undefined
    ? "(not set)"
    : v === null
      ? "Removed"
      : typeof v === "string"
        ? v
        : JSON.stringify(v, null, 2);

/**
 * One entry's conflicts: each field shows the draft's side and the repository's, then Keep mine and
 * Take the repo's. Both stay outlined: neither is the primary.
 */
/** A field's id as the form words it ("label" → "Label"). */
const fieldLabel = (field: string): string =>
  field === "managementDefault"
    ? "In the app"
    : field.charAt(0).toUpperCase() + field.slice(1);

export function ConflictPanel({
  conflict,
  onSettle,
}: {
  conflict: EntryConflict;
  onSettle: (field: string, take: boolean) => void;
}): React.ReactElement {
  return (
    <section
      aria-label={`Conflicts on ${conflict.key}`}
      className="space-y-3 rounded-lg border border-warning-border bg-warning-subtle p-4"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-warning">
        <GitMerge aria-hidden className="size-4" />
        <span>
          The repository changed this too
          {conflict.fields.length > 1
            ? ` (${conflict.fields.length} fields)`
            : ""}
        </span>
      </h3>
      <ul className="space-y-4">
        {conflict.fields.map((f) => (
          <li key={f.field} className="space-y-2">
            <p className="text-sm font-medium text-fg-strong">
              {f.field === WHOLE_ENTRY ? conflict.key : fieldLabel(f.field)}
            </p>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div className="min-w-0 rounded-md border border-border bg-surface-raised p-2">
                <dt className="text-xs text-fg-muted">Your draft</dt>
                <dd className="font-mono text-xs break-words whitespace-pre-wrap text-fg">
                  {f.field === WHOLE_ENTRY && f.mine !== null
                    ? "Edited"
                    : sideText(f.mine)}
                </dd>
              </div>
              <div className="min-w-0 rounded-md border border-border bg-surface-raised p-2">
                <dt className="text-xs text-fg-muted">The repository's</dt>
                <dd className="font-mono text-xs break-words whitespace-pre-wrap text-fg">
                  {f.field === WHOLE_ENTRY && f.theirs !== null
                    ? "Edited"
                    : sideText(f.theirs)}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                data-conflict-keep=""
                onClick={() => {
                  onSettle(f.field, false);
                  focusAfterSettle(f.field);
                }}
              >
                Keep mine
                <span className="sr-only">
                  {" "}
                  for {f.field === WHOLE_ENTRY ? conflict.key : f.field}
                </span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onSettle(f.field, true);
                  focusAfterSettle(f.field);
                }}
              >
                Take the repo's
                <span className="sr-only">
                  {" "}
                  for {f.field === WHOLE_ENTRY ? conflict.key : f.field}
                </span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
