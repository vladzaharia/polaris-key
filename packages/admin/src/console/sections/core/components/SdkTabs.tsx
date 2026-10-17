/**
 * The SDK picker (ST-41; site-06): a tablist with roving tabindex. ArrowLeft/Right move and select,
 * Home/End jump to the ends, Tab leaves the list. The selection lives in the hash query (`sdk=`),
 * so a link to a snippet opens on the same SDK.
 */

import * as React from "react";
import { cn } from "../../../../lib/cn.js";
import { SDK_OPTIONS, type SdkId } from "../model/sdkQuickStart.js";

export function SdkTabs({
  idPrefix,
  value,
  onChange,
  children,
}: {
  /** Makes the tab and panel ids unique when several pickers share a page. */
  idPrefix: string;
  value: SdkId;
  onChange: (sdk: SdkId) => void;
  /** The panel of the selected tab. */
  children: React.ReactNode;
}): React.ReactElement {
  const refs = React.useRef(new Map<SdkId, HTMLButtonElement>());
  const move = (to: SdkId) => {
    onChange(to);
    refs.current.get(to)?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = SDK_OPTIONS.findIndex((o) => o.value === value);
    const last = SDK_OPTIONS.length - 1;
    const next =
      e.key === "ArrowRight"
        ? i === last
          ? 0
          : i + 1
        : e.key === "ArrowLeft"
          ? i === 0
            ? last
            : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    move(SDK_OPTIONS[next]!.value);
  };
  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="SDK"
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-1"
      >
        {SDK_OPTIONS.map((o) => {
          const selected = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                if (el) refs.current.set(o.value, el);
                else refs.current.delete(o.value);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${o.value}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(o.value)}
              className={cn(
                "min-h-8 rounded-md border px-2.5 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus",
                selected
                  ? "border-border-strong bg-surface-raised font-medium text-fg-strong"
                  : "border-transparent text-fg-muted hover:text-fg-strong",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-tab-${value}`}
        className="space-y-3"
      >
        {children}
      </div>
    </div>
  );
}
