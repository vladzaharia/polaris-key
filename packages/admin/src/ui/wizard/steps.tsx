import * as React from "react";
import { Download } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../Button.js";
import { Callout } from "../Callout.js";
import { CodeBlock } from "../CodeBlock.js";
import { RadioCards } from "../RadioCards.js";
import { SegmentedControl } from "../SegmentedControl.js";
import { StatusPill } from "../StatusPill.js";
import type { CodeLanguage } from "../../lib/highlight.js";

// ── ChoiceStep ───────────────────────────────────────────────────────────────────────────────

export interface Choice<V extends string = string> {
  value: V;
  label: string;
  /** One line. */
  description?: string;
  /** Marks the card "Recommended", with this reason beside it. */
  recommended?: string;
  disabled?: boolean;
}

/**
 * A choose step (SETUP.md §1.2): two to six cards, each a title and one line; the recommended one
 * is marked with its reason. A choice is saved by the page when the operator continues.
 */
export function ChoiceStep<V extends string = string>({
  legend,
  choices,
  value,
  onChange,
  columns = 2,
}: {
  /** Names the group for assistive tech; the step's own heading is the visible question. */
  legend: string;
  choices: readonly Choice<V>[];
  value: V | null;
  onChange: (value: V) => void;
  columns?: 1 | 2 | 3;
}): React.ReactElement {
  return (
    <RadioCards
      aria-label={legend}
      columns={columns}
      value={value}
      onChange={onChange}
      options={choices.map((c) => ({
        value: c.value,
        disabled: c.disabled,
        label: c.recommended ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.label}
            <StatusPill tone="info" size="sm">
              Recommended
            </StatusPill>
          </span>
        ) : (
          c.label
        ),
        description: c.recommended
          ? [c.description, c.recommended].filter(Boolean).join(" ")
          : c.description,
      }))}
    />
  );
}

// ── FormStep ─────────────────────────────────────────────────────────────────────────────────

/**
 * A form step: the fewest fields the step needs. The wizard's primary button submits it through
 * `formId`. A failed save keeps the input and shows `error` above the fields, never inside them.
 */
export function FormStep({
  formId,
  onSubmit,
  error,
  children,
  className,
}: {
  formId: string;
  onSubmit: () => void;
  /** The words of the last failed save. */
  error?: { title: string; description?: string } | null;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <form
      id={formId}
      noValidate
      className={cn("space-y-4", className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {error ? (
        <Callout tone="danger" title={error.title} live>
          {error.description}
        </Callout>
      ) : null}
      {children}
    </form>
  );
}

// ── SnippetStep ──────────────────────────────────────────────────────────────────────────────

export interface SnippetTab {
  id: string;
  /** The tab's name: a language or a file. */
  label: string;
  /** The file this goes in. */
  filename: string;
  language?: CodeLanguage;
  /** Every value filled in. */
  code: string;
  /** Where the file goes ("Repository root"). */
  where?: string;
}

/**
 * A snippet step: one tab per language or file, every value filled in, Copy and Download, the file
 * name and where it goes. It completes when the fact the snippet produces is seen (usually a
 * `WaitingFor` after it).
 */
export function SnippetStep({
  tabs,
  label = "Language",
}: {
  tabs: readonly SnippetTab[];
  label?: string;
}): React.ReactElement | null {
  const [id, setId] = React.useState(tabs[0]?.id ?? "");
  const tab = tabs.find((t) => t.id === id) ?? tabs[0];
  if (!tab) return null;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([tab.code], { type: "text/plain" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = tab.filename.split("/").pop() ?? "snippet.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      {tabs.length > 1 ? (
        <SegmentedControl
          aria-label={label}
          value={tab.id}
          onChange={setId}
          options={tabs.map((t) => ({ value: t.id, label: t.label }))}
        />
      ) : null}
      <p className="text-sm text-fg-muted">
        <span className="font-mono text-fg">{tab.filename}</span>
        {tab.where ? `. ${tab.where}.` : null}
      </p>
      <CodeBlock
        code={tab.code}
        language={tab.language ?? "text"}
        filename={tab.filename}
      />
      <Button
        variant="outline"
        size="sm"
        iconStart={<Download aria-hidden />}
        onClick={download}
      >
        Download
      </Button>
    </div>
  );
}

// ── DoneStep ─────────────────────────────────────────────────────────────────────────────────

/**
 * The last step: the verified result in one line and at most two next actions. No celebration: it
 * says what is true now.
 */
export function DoneStep({
  result,
  detail,
  next,
}: {
  /** What is verified, in one line ("Google Play is set up"). */
  result: string;
  detail?: React.ReactNode;
  /** At most two buttons or links. */
  next?:
    | readonly [React.ReactNode]
    | readonly [React.ReactNode, React.ReactNode];
}): React.ReactElement {
  return (
    <div className="space-y-3">
      <Callout tone="success" title={result} live>
        {detail}
      </Callout>
      {next && next.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {next.map((n, i) => (
            <React.Fragment key={i}>{n}</React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
