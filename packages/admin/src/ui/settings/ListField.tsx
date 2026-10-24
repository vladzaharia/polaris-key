/**
 * A list of short text values as one term per line (PX-W13c). The draft is the array; the text is
 * the field's own so a trailing newline survives typing. Blank lines are not terms.
 */

import * as React from "react";
import { Textarea } from "../Textarea.js";
import { sameValue } from "./model.js";

export const termsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t !== "");

export function ListField({
  id,
  label,
  value,
  onChange,
  disabled,
  readOnly,
  describedBy,
  invalid,
}: {
  id: string;
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  readOnly?: boolean;
  describedBy?: string;
  invalid?: boolean;
}): React.ReactElement {
  const [text, setText] = React.useState(value.join("\n"));
  // The draft moved without typing (discard, a save, a reload): the text follows it.
  React.useEffect(() => {
    setText((t) => (sameValue(termsOf(t), value) ? t : value.join("\n")));
  }, [value]);
  return (
    <Textarea
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid ? true : undefined}
      rows={4}
      className="w-full sm:w-80"
      placeholder="One term per line"
      spellCheck={false}
      autoCapitalize="off"
      value={text}
      disabled={disabled}
      readOnly={readOnly}
      onValueChange={(t) => {
        setText(t);
        onChange(termsOf(t));
      }}
    />
  );
}
