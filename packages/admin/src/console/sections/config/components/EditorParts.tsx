import * as React from "react";
import { Lock, SlidersHorizontal, Stamp } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import { catalogDiagnostics } from "../../../../schema/index.js";
import { CodeEditor } from "../../../../ui/CodeEditor.js";
import { useWriteLock } from "../../../../ui/WriteLock.js";
import { ENTRY_TYPE_LABELS, type EntryType } from "./entryType.js";
import { draftDocument, type CatalogDraft } from "../model/catalogDraft.js";

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
