/**
 * "Get a badge" on the product's Polaris Locker page (LK-10): the labels the product backs, drawn
 * by @polaris-key/brand at 320 CSS px or wider, each with copy-SVG and copy-HTML. The HTML links
 * to the product's page on Polaris Locker; with no customer site there is no address to link, so
 * only the SVG copies.
 */

import * as React from "react";
import { badgeSvg, type LockerBadgeOptions } from "@polaris-key/brand/svg";
import type { PolarisKeyStatusResponse } from "../../../../api.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { useMe, useProduct } from "../../../data/hooks.js";
import { badgeHtml, lockerUrl, offeredBadges } from "../model/badges.js";

type Theme = NonNullable<LockerBadgeOptions["theme"]>;
type Treatment = NonNullable<LockerBadgeOptions["treatment"]>;

const THEMES: readonly Theme[] = ["dark", "light", "white"];
const TREATMENTS: readonly Treatment[] = ["sticker", "outline", "transparent"];
const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}): React.ReactElement {
  const id = React.useId();
  return (
    <label className="flex items-center gap-2 text-sm text-fg">
      <span id={id}>{label}</span>
      <select
        aria-labelledby={id}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-h-9 rounded-md border border-border bg-surface-raised px-2 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {cap(o)}
          </option>
        ))}
      </select>
    </label>
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
  const url = lockerUrl(me?.customerOrigin, slug);
  const offered = offeredBadges(status, product);
  return (
    <SettingsSection id="pk-badges" title="Get a badge">
      <p className="mb-4 text-sm text-fg-muted">
        Only what this product does is offered. Each badge links to its page on
        Polaris Locker.
      </p>
      <div className="mb-4 flex flex-wrap gap-4">
        <Choice
          label="Ground"
          value={theme}
          options={THEMES}
          onChange={setTheme}
        />
        <Choice
          label="Style"
          value={treatment}
          options={TREATMENTS}
          onChange={setTreatment}
        />
      </div>
      <ul className="grid gap-4 md:grid-cols-2">
        {offered.map((b) => {
          const svg = badgeSvg({ kind: b.kind, treatment, theme });
          const name = `${b.kind.slice(7).replace(/-/g, " ")}`;
          return (
            <li
              key={b.kind}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <div
                className="overflow-x-auto rounded-md p-3"
                style={{
                  background: theme === "dark" ? "#0b0f1a" : "#f4f6fb",
                }}
                // The kit's own paths: no script, no style, no external reference.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
              <p className="text-xs text-fg-muted">{b.because}</p>
              <div className="flex flex-wrap items-center gap-3">
                <CopyButton
                  showLabel
                  text="Copy SVG"
                  label={`Copy SVG, ${name}`}
                  value={svg}
                />
                {url ? (
                  <CopyButton
                    showLabel
                    text="Copy HTML"
                    label={`Copy HTML, ${name}`}
                    value={badgeHtml(svg, url, `${cap(name)} Polaris Locker`)}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {url ? null : (
        <p className="mt-3 text-xs text-fg-muted">
          There is no customer site yet, so only the SVG copies.
        </p>
      )}
    </SettingsSection>
  );
}
