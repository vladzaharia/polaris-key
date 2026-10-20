/**
 * "Get a badge" on the product's Polaris Locker page (LK-10): the labels the product backs, drawn
 * by @polaris-key/brand at 320 CSS px or wider, each with Copy SVG and Copy HTML. The HTML links
 * to the product's page on Polaris Locker; with no customer origin there is no address to link, so
 * only the SVG copies.
 *
 * One column until two 344 px previews fit (a container query), and the card chrome drops below
 * that so a 320 px badge fits a 360 px screen. A preview never scrolls sideways unless the column
 * is narrower than the art, and then it is a labelled, focusable region.
 */

import * as React from "react";
import { badgeSvg, type LockerBadgeOptions } from "@polaris-key/brand/svg";
import type { PolarisKeyStatusResponse } from "../../../../api.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Select } from "../../../../ui/Select.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { useMe, useProduct } from "../../../data/hooks.js";
import {
  badgeHtml,
  lockerUrl,
  offeredBadges,
  visibleOnLocker,
} from "../model/badges.js";

type Theme = NonNullable<LockerBadgeOptions["theme"]>;
type Treatment = NonNullable<LockerBadgeOptions["treatment"]>;

const COLOURS: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "white", label: "White" },
];
const STYLES: { value: Treatment; label: string }[] = [
  { value: "sticker", label: "Sticker" },
  { value: "outline", label: "Outline" },
  { value: "transparent", label: "Transparent" },
];

/** The ground each colour is made for: white ink goes on dark. */
const groundOf = (t: Theme): string => (t === "light" ? "#f4f6fb" : "#0b0f1a");

const labelOf = (slug: string): string => {
  const w = slug.replace(/-/g, " ");
  return w[0]!.toUpperCase() + w.slice(1);
};

function Picker<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): React.ReactElement {
  const id = React.useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg">
      <label htmlFor={id}>{label}</label>
      <Select
        id={id}
        className="w-full max-w-36"
        value={value}
        options={options}
        onChange={(v) => v && onChange(v as T)}
      />
    </div>
  );
}

/** The art on its ground; a tab stop only when the column is narrower than the art. */
function Preview({
  name,
  svg,
  ground,
}: {
  name: string;
  svg: string;
  ground: string;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = (): void => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [svg]);
  return (
    <div
      ref={ref}
      {...(scrolls
        ? { role: "region", "aria-label": `${name} preview`, tabIndex: 0 }
        : {})}
      className="flex justify-center overflow-x-auto rounded-md @[344px]:p-3"
      style={{ background: ground }}
      // The kit's own paths: no script, no style, no external reference.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function LockerBadges({
  slug,
  status,
}: {
  slug: string;
  status: PolarisKeyStatusResponse;
}): React.ReactElement {
  const product = useProduct(slug).data;
  const me = useMe().data;
  const [theme, setTheme] = React.useState<Theme>("dark");
  const [treatment, setTreatment] = React.useState<Treatment>("sticker");
  const visible = visibleOnLocker(status);
  const home = me?.customerOrigin ? `${me.customerOrigin}/` : null;
  // Not visible there yet: the badge still links, to Polaris Locker's home.
  const url = visible ? lockerUrl(me?.customerOrigin, slug) : home;
  const offered = offeredBadges(status, product);
  return (
    <SettingsSection id="pk-badges" title="Get a badge">
      <div className="@container min-w-0 py-4">
        <p className="mb-4 px-5 text-sm text-fg-muted">
          Only what this product does is offered.{" "}
          {!url
            ? "There is no Polaris Locker address to link yet, so only the art copies."
            : visible
              ? "Each badge links to its page on Polaris Locker."
              : "This product is not visible on Polaris Locker, so each badge links to its home."}
        </p>
        <div className="mb-4 flex flex-wrap gap-4 px-5">
          <Picker
            label="Color"
            value={theme}
            options={COLOURS}
            onChange={setTheme}
          />
          <Picker
            label="Style"
            value={treatment}
            options={STYLES}
            onChange={setTreatment}
          />
        </div>
        <ul className="grid min-w-0 gap-6 @[720px]:grid-cols-2 @[720px]:gap-4 @[720px]:px-5">
          {offered.map((b) => {
            const svg = badgeSvg({ kind: b.kind, treatment, theme });
            const name = `${labelOf(b.kind.slice(7))} Polaris Locker`;
            return (
              <li
                key={b.kind}
                className="flex min-w-0 flex-col gap-2 [&>:not(:first-child)]:px-5 @[720px]:[&>:not(:first-child)]:px-0 @[720px]:rounded-lg @[720px]:border @[720px]:border-border @[720px]:p-3"
              >
                <Preview name={name} svg={svg} ground={groundOf(theme)} />
                {b.because ? (
                  <p className="text-xs text-fg-muted">{b.because}</p>
                ) : null}
                <div className="mt-auto flex flex-wrap items-center gap-3">
                  <CopyButton
                    showLabel
                    text="Copy SVG"
                    label={`Copy SVG: ${name}`}
                    value={svg}
                  />
                  {url ? (
                    <CopyButton
                      showLabel
                      text="Copy HTML"
                      label={`Copy HTML: ${name}`}
                      value={badgeHtml(svg, url, name)}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsSection>
  );
}
