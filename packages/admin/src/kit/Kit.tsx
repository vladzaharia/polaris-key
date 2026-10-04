/**
 * The component gallery at `#/__kit` (docs/design/ADMIN.md §4): every component in its states,
 * in both themes and every section accent. Compiled only in development (`import.meta.env.DEV`
 * in App.tsx); it is the review surface for chunk 3 and needs no session or network.
 */

import * as React from "react";
import { useTheme, type ThemePreference } from "../components/theme.js";
import { SERVICE_TABLE } from "../services.generated.js";
import { cn } from "../lib/cn.js";
import { KitProviders } from "./KitProviders.js";
import { STORIES } from "./stories/index.js";
import { KIT_GROUPS } from "./types.js";

const ACCENTS = ["core", ...SERVICE_TABLE.map((s) => s.slug)] as const;

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
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <span className="mr-1 text-xs text-fg-muted">{label}</span>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-xs capitalize text-fg",
            o === value &&
              "border-accent bg-accent-subtle font-bold text-fg-strong",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export default function Kit(): React.ReactElement {
  const { preference, setPreference } = useTheme();
  const [accent, setAccent] = React.useState<(typeof ACCENTS)[number]>("core");
  const [filter, setFilter] = React.useState("");

  React.useEffect(() => {
    document.title = "Component gallery · Polaris Key";
  }, []);

  const shown = STORIES.filter(
    (s) =>
      !filter ||
      `${s.title} ${s.id} ${s.group}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );

  return (
    <KitProviders>
      <div data-service={accent} className="min-h-dvh bg-surface-page text-fg">
        <header className="sticky top-0 z-40 flex flex-wrap items-center gap-4 border-b border-border bg-surface-raised px-6 py-3">
          <h1 className="text-lg font-bold text-fg-strong">
            Component gallery
          </h1>
          <Choice<ThemePreference>
            label="Theme"
            value={preference}
            options={["system", "dark", "light"]}
            onChange={setPreference}
          />
          <Choice
            label="Section"
            value={accent}
            options={ACCENTS}
            onChange={setAccent}
          />
          <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
            Filter
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 rounded-md border border-border-strong bg-surface-sunken px-2 text-sm text-fg"
            />
          </label>
        </header>
        <div className="mx-auto grid max-w-[90rem] gap-8 px-6 py-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <nav aria-label="Gallery" className="hidden lg:block">
            <ul className="sticky top-20 space-y-3 text-sm">
              {KIT_GROUPS.map((g) => (
                <li key={g}>
                  <p className="font-bold text-fg-strong">{g}</p>
                  <ul className="mt-1 space-y-0.5">
                    {shown
                      .filter((s) => s.group === g)
                      .map((s) => (
                        <li key={s.id}>
                          <a
                            href={`#/__kit?story=${s.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              document
                                .getElementById(`story-${s.id}`)
                                ?.scrollIntoView();
                            }}
                            className="text-fg-muted hover:text-fg-strong"
                          >
                            {s.title}
                          </a>
                        </li>
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          </nav>
          <main className="min-w-0 space-y-10">
            {KIT_GROUPS.map((g) => {
              const group = shown.filter((s) => s.group === g);
              if (group.length === 0) return null;
              return (
                <section
                  key={g}
                  aria-labelledby={`group-${g}`}
                  className="space-y-6"
                >
                  <h2
                    id={`group-${g}`}
                    className="border-b border-border pb-2 text-xl font-bold text-fg-strong"
                  >
                    {g}
                  </h2>
                  {group.map((s) => (
                    <article
                      key={s.id}
                      id={`story-${s.id}`}
                      aria-labelledby={`story-title-${s.id}`}
                      className="scroll-mt-20 rounded-lg border border-border bg-surface-raised"
                    >
                      <header className="border-b border-border px-4 py-2">
                        <h3
                          id={`story-title-${s.id}`}
                          className="text-sm font-bold text-fg-strong"
                        >
                          {s.title}{" "}
                          <code className="ml-2 font-mono text-xs font-normal text-fg-subtle">
                            {s.id}
                          </code>
                        </h3>
                        {s.description ? (
                          <p className="text-xs text-fg-muted">
                            {s.description}
                          </p>
                        ) : null}
                      </header>
                      <div className="p-4">{s.render()}</div>
                    </article>
                  ))}
                </section>
              );
            })}
          </main>
        </div>
      </div>
    </KitProviders>
  );
}
