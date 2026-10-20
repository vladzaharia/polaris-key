import * as React from "react";
import { Check, Copy } from "lucide-react";
import { truncateMiddle } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { useCopy } from "../../../ui/CopyButton.js";
import { Popover } from "../../../ui/Popover.js";
import { GET_IT_COPY as C } from "../../copy/getIt.js";

/**
 * A file's SHA-256 in the downloads table (PX-28a): middle-truncated in mono, the whole value in
 * a popover (never only a `title`) and a Copy button. Both targets are 44 px, and both are named
 * for the file, so a table of them reads as a list of distinct controls.
 */
export function FileHash({
  value,
  file,
}: {
  value: string;
  file: string;
}): React.ReactElement {
  const short = truncateMiddle(value, 6, 4);
  const { copy, state } = useCopy();
  return (
    <span className="inline-flex items-center">
      <Popover
        label={C["getIt.flow.fullSha256"]}
        trigger={
          <button
            type="button"
            aria-label={`${C["getIt.flow.sha256"]} ${file} ${short}`}
            className="inline-flex min-h-11 min-w-11 items-center whitespace-nowrap rounded-md px-1 font-mono text-code text-fg hover:text-fg-strong"
          >
            <span aria-hidden>{short}</span>
          </button>
        }
      >
        <p className="mb-1 text-xs text-fg-muted">
          {C["getIt.flow.fullSha256"]}
        </p>
        <code className="break-all font-mono text-code text-fg-strong">
          {value}
        </code>
      </Popover>
      <Button
        variant="ghost"
        className="size-11 min-w-11 px-0"
        aria-label={`${C["getIt.flow.copySha256"]} ${file}`}
        onClick={() => void copy(value)}
      >
        {state === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </span>
  );
}
