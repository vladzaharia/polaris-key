import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./Button.js";
import { cn } from "../lib/cn.js";
import { t } from "../lib/copy.js";
import { spellOut } from "../lib/supportCode.js";

/**
 * "Spell it out" (I-41s): a disclosure that reads a support code symbol by symbol, "K · Kilo", in
 * its three groups, so a customer can say it over the phone and an agent can confirm it. Sighted
 * readers see the pair; a screen reader hears "K as in Kilo", each group a labelled list. Renders
 * nothing for text that is not a valid code. `touch`: the customer portal's 44 px target (the
 * console's is 24 px or more).
 */
export function SpellOut({
  code,
  touch = false,
  inline = false,
  className,
}: {
  code: string;
  touch?: boolean;
  /** Sit among a flex-wrap row's items: the button is one, the readout takes a row of its own. */
  inline?: boolean;
  className?: string;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const groups = spellOut(code);
  if (groups.length === 0) return null;
  return (
    <div className={cn(inline ? "contents" : "min-w-0", className)}>
      <Button
        variant="ghost"
        size={touch ? "md" : "xs"}
        className={cn(!inline && "-ms-2", touch && "min-h-11")}
        aria-expanded={open}
        aria-controls={panelId}
        iconEnd={
          <ChevronDown
            aria-hidden
            className={cn("transition-transform", open && "rotate-180")}
          />
        }
        onClick={() => setOpen((o) => !o)}
      >
        {t("yourData.product.support.spell")}
      </Button>
      <div
        id={panelId}
        hidden={!open}
        className={cn(open && (inline ? "mt-1 basis-full" : "mt-2"))}
      >
        {open ? (
          <div className="flex flex-wrap gap-2">
            {groups.map((group, g) => (
              <ul
                key={g}
                aria-label={t("yourData.product.support.spellGroup", {
                  n: g + 1,
                })}
                className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 rounded-md border border-border bg-surface-sunken px-3 py-2"
              >
                {group.map(({ symbol, word }, i) => (
                  <li key={i} className="min-w-0">
                    <span aria-hidden className="whitespace-nowrap">
                      <span className="font-mono font-semibold text-fg-strong">
                        {symbol}
                      </span>
                      <span className="text-fg-muted"> · {word}</span>
                    </span>
                    <span className="sr-only">
                      {t("yourData.product.support.spellSymbol", {
                        s: symbol,
                        name: word,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
