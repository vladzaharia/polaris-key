/**
 * The web-origins list editor (ST-08, `core.web.origins`): browser origins allowed to call the
 * product's endpoints. One origin per row with Remove, and an add field below. An origin is
 * checked as the Worker checks it (an `https://host[:port]` exactly as a browser writes it;
 * `http` only for localhost), so a mistake is named before the save, not after.
 *
 * Controlled: the parent form owns the list and its one SaveBar (UPS-1); this holds only the text
 * being typed.
 */

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { IconButton } from "../../ui/IconButton.js";
import { Input } from "../../ui/Input.js";

/** Mirrors `webOriginProblem` (`@polaris-key/manifest`); the Worker stays the authority. */
export function originProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter an origin such as https://app.example.com.";
  if (/[*\s]/.test(value)) return "No wildcards or spaces.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter an origin such as https://app.example.com.";
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    return "Use https. Plain http works only for localhost.";
  if (url.origin !== value)
    return `Write it the way a browser sends it: ${url.origin}`;
  return null;
}

export const MAX_ORIGINS = 16;

export function OriginsEditor({
  id,
  value,
  onChange,
  disabled,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}): React.ReactElement {
  const [text, setText] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const list = React.useRef<HTMLUListElement>(null);
  const problemId = `${id}-problem`;
  /** Where focus goes once the list has changed: the Remove that took a removed row's place. */
  const refocus = React.useRef<{ index: number } | null>(null);
  React.useEffect(() => {
    const at = refocus.current;
    if (!at) return;
    refocus.current = null;
    const removes = list.current?.querySelectorAll<HTMLButtonElement>(
      "button[data-origin-remove]",
    );
    if (removes && removes.length > 0)
      removes[Math.min(at.index, removes.length - 1)]!.focus();
    else input.current?.focus();
  }, [value]);
  const full = value.length >= MAX_ORIGINS;

  const add = (): void => {
    const origin = text.trim();
    const why =
      originProblem(origin) ??
      (value.includes(origin) ? "Already in the list." : null);
    setProblem(why);
    if (why) return;
    onChange([...value, origin]);
    setText("");
    input.current?.focus();
  };

  return (
    <div className="w-full min-w-0 space-y-2 sm:max-w-md">
      {value.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No browser origins. Pages on other sites cannot call this product.
        </p>
      ) : (
        <ul
          ref={list}
          aria-label="Web origins"
          className="divide-y divide-border rounded-md border border-border"
        >
          {value.map((origin, index) => (
            <li
              key={origin}
              className="flex items-center justify-between gap-2 py-1 pl-3 pr-1"
            >
              <span className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">
                {origin}
              </span>
              <IconButton
                label={`Remove ${origin}`}
                icon={<X />}
                size="sm"
                disabled={disabled}
                data-origin-remove=""
                onClick={() => {
                  refocus.current = { index };
                  onChange(value.filter((o) => o !== origin));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            ref={input}
            id={id}
            mono
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://app.example.com"
            aria-label="Add a web origin"
            aria-describedby={
              [describedBy, problem ? problemId : undefined]
                .filter(Boolean)
                .join(" ") || undefined
            }
            aria-invalid={invalid || problem ? true : undefined}
            disabled={disabled || full}
            value={text}
            onValueChange={(v) => {
              setText(v);
              if (problem) setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Enter adds the origin; it must not submit the surrounding form.
              e.preventDefault();
              add();
            }}
          />
          {problem ? (
            <p id={problemId} role="alert" className="text-xs text-danger">
              {problem}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          iconStart={<Plus aria-hidden />}
          disabled={disabled || full || text.trim() === ""}
          onClick={add}
        >
          Add
        </Button>
      </div>
      {full ? (
        <p className="text-xs text-fg-muted">At most {MAX_ORIGINS} origins.</p>
      ) : null}
    </div>
  );
}
