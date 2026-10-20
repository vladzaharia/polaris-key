/**
 * What to register at a provider (LK-10): one address per place a person may sign in. Polaris
 * Locker (the customer site) is listed first when there is one, then the Polaris Key Console while
 * customers may still sign in there. A single address shows without a site name.
 */

import * as React from "react";
import { CopyButton } from "../../../../ui/CopyButton.js";

export interface RegisterAddress {
  label?: string;
  value: string;
}

export function RegisterAddresses({
  title,
  addresses,
  copyLabel,
  inline = false,
}: {
  /** "Redirect URI" or "Realm". */
  title: string;
  addresses: readonly RegisterAddress[];
  copyLabel: string;
  /** The code box fills its row (the connection page) instead of hugging its text. */
  inline?: boolean;
}): React.ReactElement {
  const many = addresses.length > 1;
  return (
    <div className="space-y-1">
      <p className="text-xs text-fg-muted">{title}</p>
      <ul className="space-y-2">
        {addresses.map((a) => (
          <li key={a.value} className="space-y-0.5">
            {many && a.label ? (
              <p className="text-xs font-medium text-fg-strong">{a.label}</p>
            ) : null}
            <div className="flex items-center gap-2">
              <code
                className={
                  inline
                    ? "min-w-0 flex-1 break-all rounded-md bg-surface-sunken px-2 py-1 text-xs"
                    : "min-w-0 break-all text-xs"
                }
              >
                {a.value}
              </code>
              <CopyButton
                value={a.value}
                label={
                  many && a.label ? `${copyLabel} (${a.label})` : copyLabel
                }
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The console's own `/callback` plus Polaris Locker's, when the customer site exists. */
export function registerAt(
  consoleUri: string,
  customerOrigin: string | null,
): RegisterAddress[] {
  const own = { label: "Polaris Key Console", value: consoleUri };
  if (customerOrigin === null) return [{ value: consoleUri }];
  const locker = {
    label: "Polaris Locker",
    value: `${customerOrigin}/callback`,
  };
  return locker.value === own.value ? [own] : [locker, own];
}
