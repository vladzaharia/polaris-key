import { t } from "../../../lib/copy.js";
import * as React from "react";
import { Tabs } from "radix-ui";
import type { FeedSnippet } from "@polaris-key/manifest";
import { CodeBlock } from "../../../ui/CodeBlock.js";

export type TabSnippet = FeedSnippet & { feed: string };

interface ClientGroup {
  key: string;
  label: string;
  snippets: TabSnippet[];
}

/** "npm, pnpm" reads "npm and pnpm"; one client reads as it is. */
function clientLabel(clients: string): string {
  const parts = clients.split(/,\s*/);
  return parts.length > 1
    ? t("locker.list.and", {
        first: parts.slice(0, -1).join(", "),
        rest: parts[parts.length - 1]!,
      })
    : clients;
}

/**
 * One tab per client. Snippets for the same client (uv's configuration and its credentials) share
 * a tab, and so does a client that another tab already covers ("npm" inside "npm, pnpm": the
 * install command goes with the configuration). Several snippets in a tab each get a heading.
 */
export function groupByClient(snippets: readonly TabSnippet[]): ClientGroup[] {
  const groups: ClientGroup[] = [];
  const names = (clients: string): string[] => clients.split(/,\s*/);
  for (const s of snippets) {
    const mine = names(s.clients);
    const host = groups.find((g) => {
      const theirs = names(g.snippets[0]!.clients);
      return (
        g.snippets[0]!.clients === s.clients ||
        (g.snippets[0]!.feed === s.feed &&
          (mine.every((m) => theirs.includes(m)) ||
            theirs.every((t) => mine.includes(t))))
      );
    });
    if (host) host.snippets.push(s);
    else
      groups.push({
        key: `${s.feed}-${groups.length}`,
        label: clientLabel(s.clients),
        snippets: [s],
      });
  }
  return groups;
}

/** The setup snippets as tabs named for the client (npm and pnpm, Yarn, Bun, uv …). */
export function SetupTabs({
  snippets,
}: {
  snippets: readonly TabSnippet[];
}): React.ReactElement | null {
  const tabs = groupByClient(snippets);
  const [current, setCurrent] = React.useState(tabs[0]?.key ?? "");
  if (tabs.length === 0) return null;
  return (
    <Tabs.Root
      value={tabs.some((t) => t.key === current) ? current : tabs[0]!.key}
      onValueChange={setCurrent}
      className="min-w-0 space-y-3"
    >
      <Tabs.List
        aria-label={t("locker.setup.packageManager")}
        className="relative flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((t) => (
          <Tabs.Trigger
            key={t.key}
            value={t.key}
            className="-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 text-sm text-fg-muted hover:text-fg-strong data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-fg-strong"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.key} value={t.key} className="space-y-4">
          {t.snippets.map((s, i) => (
            <div key={`${s.id}-${i}`} className="space-y-1.5">
              <p className="text-sm text-fg">{s.title}</p>
              {s.warning ? (
                <p className="text-xs text-warning">{s.warning}</p>
              ) : null}
              <CodeBlock
                code={s.code}
                language={s.language}
                filename={s.filename}
                copy
                className="[&_button]:min-h-11 [&_button]:min-w-11"
              />
            </div>
          ))}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
