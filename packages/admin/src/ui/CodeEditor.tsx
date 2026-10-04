import * as React from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./Button.js";

/** A problem the validator found, 1-based line and column. */
export interface CodeDiagnostic {
  line: number;
  column: number;
  message: string;
  severity?: "error" | "warning";
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: "json" | "yaml";
  /** Lint markers: the catalog validator, the payload validator. */
  validate?: (text: string) => CodeDiagnostic[];
  readOnly?: boolean;
  /** Offer "Format" (JSON only). */
  formattable?: boolean;
  /** Tailwind height class for the editor area. */
  heightClass?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** The props the lazily loaded CodeMirror implementation takes. */
export interface CodeEditorImplProps extends Omit<
  CodeEditorProps,
  "formattable" | "className"
> {
  onDiagnostics?: (count: number) => void;
}

/**
 * CodeMirror 6, loaded on first use (components.md §3.3): the catalog and payload JSON editors
 * only, so the editor never reaches the main bundle. Until it loads, a read-only textarea shows
 * the text. CodeMirror styles itself through constructable stylesheets (style-mod's
 * `adoptedStyleSheets`), never a `<style>` element, so it runs under the Worker's CSP.
 */
const Impl = React.lazy(() => import("./CodeEditorImpl.js"));

/** Pretty-print JSON; `null` when it does not parse. */
export function formatJson(text: string): string | null {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return null;
  }
}

/** The editor's loading state: the text, read-only, the same size. */
export function CodeEditorFallback({
  value,
  heightClass = "h-64",
  id,
  ...aria
}: Pick<
  CodeEditorProps,
  | "value"
  | "heightClass"
  | "id"
  | "aria-label"
  | "aria-labelledby"
  | "aria-describedby"
>): React.ReactElement {
  return (
    <textarea
      id={id}
      readOnly
      aria-busy="true"
      value={value}
      className={cn(
        "w-full resize-none rounded-md border border-border-strong bg-surface-sunken p-3 font-mono text-xs text-fg-muted",
        heightClass,
      )}
      {...aria}
    />
  );
}

export function CodeEditor({
  formattable,
  className,
  ...props
}: CodeEditorProps): React.ReactElement {
  const [problems, setProblems] = React.useState(0);
  const canFormat = formattable && props.language === "json" && !props.readOnly;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {canFormat || problems > 0 ? (
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="text-xs text-fg-muted">
            {problems > 0
              ? `${problems} ${problems === 1 ? "problem" : "problems"}`
              : ""}
          </p>
          {canFormat ? (
            <Button
              size="xs"
              variant="outline"
              disabledReason={
                formatJson(props.value) === null
                  ? "Fix the JSON before formatting it."
                  : undefined
              }
              onClick={() => {
                const pretty = formatJson(props.value);
                if (pretty !== null) props.onChange?.(pretty);
              }}
            >
              Format
            </Button>
          ) : null}
        </div>
      ) : null}
      <React.Suspense fallback={<CodeEditorFallback {...props} />}>
        <Impl {...props} onDiagnostics={setProblems} />
      </React.Suspense>
    </div>
  );
}
