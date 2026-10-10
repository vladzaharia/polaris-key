/**
 * The CodeMirror half of `CodeEditor`, imported lazily (keep every `@codemirror/*` import in this
 * file so the main bundle never pulls the editor in).
 */

import * as React from "react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { cn } from "../lib/cn.js";
import type { CodeDiagnostic, CodeEditorImplProps } from "./CodeEditor.js";

/** Brand tokens only: the editor follows data-theme and data-service like everything else. */
const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--pk-surface-sunken)",
    color: "var(--pk-text-default)",
    fontSize: "var(--pk-font-size-xs)",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "var(--pk-font-mono)",
    caretColor: "var(--pk-text-strong)",
  },
  ".cm-scroller": { fontFamily: "var(--pk-font-mono)" },
  ".cm-gutters": {
    backgroundColor: "var(--pk-surface-sunken)",
    color: "var(--pk-text-subtle)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--pk-surface-raised)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--pk-surface-raised)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--pk-accent-subtle)",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--pk-danger)",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--pk-warning)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--pk-surface-overlay)",
    color: "var(--pk-text-default)",
    border: "1px solid var(--pk-border-subtle)",
  },
});

const highlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--pk-text-strong)", fontWeight: "600" },
  { tag: [tags.string], color: "var(--pk-text-default)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--pk-accent-fg)" },
  { tag: [tags.punctuation, tags.bracket], color: "var(--pk-text-muted)" },
  { tag: tags.comment, color: "var(--pk-text-subtle)" },
]);

function toDiagnostics(
  view: EditorView,
  found: CodeDiagnostic[],
): Diagnostic[] {
  const doc = view.state.doc;
  return found.map((d) => {
    const line = doc.line(Math.min(Math.max(1, d.line), doc.lines));
    const from = Math.min(line.from + Math.max(0, d.column - 1), line.to);
    return {
      from,
      to: Math.min(from + 1, line.to) || from,
      severity: d.severity ?? "error",
      message: d.message,
    };
  });
}

export default function CodeEditorImpl({
  value,
  onChange,
  language,
  validate,
  readOnly,
  heightClass = "h-64",
  id,
  onDiagnostics,
  ...aria
}: CodeEditorImplProps): React.ReactElement {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  const latest = React.useRef({ onChange, validate, onDiagnostics });
  latest.current = { onChange, validate, onDiagnostics };
  const editable = React.useRef(new Compartment());

  React.useEffect(() => {
    if (!host.current) return;
    const attrs: Record<string, string> = { "aria-multiline": "true" };
    for (const [k, v] of Object.entries(aria)) if (v) attrs[k] = v;
    if (id) attrs.id = id;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          bracketMatching(),
          // Tab is left to focus navigation (no indentWithTab): the editor never traps focus.
          keymap.of([...defaultKeymap, ...historyKeymap]),
          language === "json" ? json() : yaml(),
          syntaxHighlighting(highlight),
          theme,
          lintGutter(),
          linter(
            (ev) => {
              const found =
                latest.current.validate?.(ev.state.doc.toString()) ?? [];
              latest.current.onDiagnostics?.(found.length);
              return toDiagnostics(ev, found);
            },
            { delay: 300 },
          ),
          editable.current.of(EditorState.readOnly.of(Boolean(readOnly))),
          EditorView.contentAttributes.of(attrs),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; value and readOnly sync below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  React.useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  React.useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(
        EditorState.readOnly.of(Boolean(readOnly)),
      ),
    });
  }, [readOnly]);

  return (
    <div
      ref={host}
      className={cn(
        "overflow-hidden rounded-md border border-border-strong focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2 focus-within:ring-offset-surface-page",
        heightClass,
      )}
    />
  );
}
