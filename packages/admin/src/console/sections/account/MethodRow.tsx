/**
 * One sign-in method (ST-30c.4), laid out as the Locker's `MethodRow` is: a wrapping row, a text
 * block with a real basis and actions that drop under the name when the row is narrow, so 200 %
 * text never squeezes the name to nothing.
 */

import * as React from "react";
import { KeyRound, Link2, Mail } from "lucide-react";
import type { ConsoleMethod } from "../../../api.js";
import { fromSeconds, formatDateTime } from "../../../lib/format.js";
import { kindLabel } from "../../../lib/methodNames.js";
import { Button } from "../../../ui/Button.js";
import { Timestamp } from "../../../ui/Timestamp.js";

function KindIcon({ kind }: { kind: string }): React.ReactElement {
  const Icon = kind === "passkey" ? KeyRound : kind === "email" ? Mail : Link2;
  return <Icon aria-hidden className="size-5" />;
}

export function MethodRow({
  method,
  title,
  onUse,
}: {
  method: ConsoleMethod;
  title: string;
  onUse: (m: ConsoleMethod) => void;
}): React.ReactElement {
  const kind = kindLabel(method.kind);
  return (
    <li
      data-method-id={method.id}
      tabIndex={-1}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 focus:outline-2 focus:-outline-offset-2 focus:outline-focus"
    >
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-fg-muted"
      >
        <KindIcon kind={method.kind} />
      </span>
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-medium text-fg-strong [overflow-wrap:anywhere]">
          {title}
        </p>
        <p className="text-xs text-fg-muted">
          {title.startsWith(kind) ? null : (
            <>
              <span className="whitespace-nowrap">{kind}</span>
              {" · "}
            </>
          )}
          <span className="whitespace-nowrap">
            Added <Timestamp at={fromSeconds(method.createdAt)} format="date" />
          </span>
          {" · "}
          <span className="whitespace-nowrap">
            {method.lastUsedAt === null ? (
              "Never used"
            ) : (
              <>
                Used <Timestamp at={fromSeconds(method.lastUsedAt)} />
              </>
            )}
          </span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:ms-auto">
        {method.consoleEligible ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUse(method)}
            aria-label={`Use for the console: ${title}, added ${formatDateTime(fromSeconds(method.createdAt))}`}
          >
            Use for the console
          </Button>
        ) : method.kind === "passkey" && !method.strong ? (
          <span className="text-xs text-fg-muted">Saved for another site</span>
        ) : null}
      </div>
    </li>
  );
}
