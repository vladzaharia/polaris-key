/**
 * The SDK picker (ST-41; site-06): a tablist with roving tabindex. ArrowLeft/Right move and select,
 * Home/End jump to the ends, Tab leaves the list. The selection lives in the hash query (`sdk=`),
 * so a link to a snippet opens on the same SDK.
 *
 * The first three SDKs of `order` (the product's fit leads) and the selected one show; "More"
 * reveals the rest. The selected tab's id is `<idPrefix>-tab`, so a link can focus it whichever
 * SDK is picked. A pick keeps the clicked tab where it was on screen, however the content above
 * it changes height.
 */

import * as React from "react";
import { SDK_LABELS } from "@polaris-key/manifest/integration";
import { cn } from "../../../../lib/cn.js";
import { SDK_OPTIONS, type SdkId } from "../model/sdkQuickStart.js";

const SHOWN = 3;

/** The nearest ancestor that scrolls vertically (the shell's main region), or null. */
function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight)
      return n;
  }
  return null;
}

export function SdkTabs({
  idPrefix,
  value,
  onChange,
  order,
  children,
}: {
  /** Makes the tab and panel ids unique when several pickers share a page. */
  idPrefix: string;
  value: SdkId;
  onChange: (sdk: SdkId) => void;
  /** The SDKs in the order to show them; the product's fit first. */
  order?: readonly SdkId[];
  /** The panel of the selected tab. */
  children: React.ReactNode;
}): React.ReactElement {
  const refs = React.useRef(new Map<SdkId, HTMLButtonElement>());
  const anchor = React.useRef<number | null>(null);
  const [more, setMore] = React.useState(false);
  const all = order ?? SDK_OPTIONS.map((o) => o.value);
  const shown = all.filter((s, i) => more || i < SHOWN || s === value);
  const hidden = all.length - shown.length;

  // After a pick, put the clicked tab back where it was on screen.
  React.useLayoutEffect(() => {
    const was = anchor.current;
    anchor.current = null;
    const el = refs.current.get(value);
    if (was === null || !el) return;
    const delta = el.getBoundingClientRect().top - was;
    if (delta === 0) return;
    const box = scroller(el);
    if (box) box.scrollTop += delta;
  }, [value]);

  const pick = (to: SdkId, focus = false) => {
    anchor.current =
      refs.current.get(value)?.getBoundingClientRect().top ?? null;
    onChange(to);
    if (focus) refs.current.get(to)?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = shown.indexOf(value);
    const last = shown.length - 1;
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
    pick(shown[next]!, true);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        <div
          role="tablist"
          aria-label="SDK"
          onKeyDown={onKeyDown}
          className="flex flex-wrap gap-1"
        >
          {shown.map((sdk) => {
            const selected = sdk === value;
            return (
              <button
                key={sdk}
                ref={(el) => {
                  if (el) refs.current.set(sdk, el);
                  else refs.current.delete(sdk);
                }}
                type="button"
                role="tab"
                id={selected ? `${idPrefix}-tab` : `${idPrefix}-tab-${sdk}`}
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => pick(sdk)}
                className={cn(
                  "min-h-8 rounded-md border px-2 text-sm focus-visible:outline-2 focus-visible:outline-focus",
                  selected
                    ? "border-border-strong bg-surface-raised font-medium text-fg-strong"
                    : "border-transparent text-fg-muted hover:text-fg-strong",
                )}
              >
                {SDK_LABELS[sdk]}
              </button>
            );
          })}
        </div>
        {hidden > 0 || more ? (
          <button
            type="button"
            aria-label={more ? "Fewer SDKs" : "More SDKs"}
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
            className="min-h-8 rounded-md px-2 text-sm text-fg-muted hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-focus"
          >
            {more ? "Fewer" : "More"}
          </button>
        ) : null}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-tab`}
        className="space-y-3"
      >
        {children}
      </div>
    </div>
  );
}
