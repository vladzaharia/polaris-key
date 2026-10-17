import * as React from "react";
import { Tabs } from "radix-ui";
import type { FeedSnippet } from "@polaris-key/manifest";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { ecosystemLabel } from "../../model/packageAccess.js";

export type TabSnippet = FeedSnippet & { feed: string };

/** The setup snippets as tabs (npm, pnpm, Yarn …), each a copyable code block. */
export function SetupTabs({
  snippets,
}: {
  snippets: readonly TabSnippet[];
}): React.ReactElement | null {
  const multiFeed = new Set(snippets.map((s) => s.feed)).size > 1;
  const tabs = snippets.map((s, i) => ({
    key: `${s.feed}-${s.id}-${i}`,
    label: multiFeed ? `${ecosystemLabel(s.feed)}: ${s.clients}` : s.clients,
    snippet: s,
  }));
  const [current, setCurrent] = React.useState(tabs[0]?.key ?? "");
  if (tabs.length === 0) return null;
  return (
    <Tabs.Root
      value={tabs.some((t) => t.key === current) ? current : tabs[0]!.key}
      onValueChange={setCurrent}
      className="min-w-0 space-y-2"
    >
      <Tabs.List
        aria-label="Setup"
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((t) => (
          <Tabs.Trigger
            key={t.key}
            value={t.key}
            className="-mb-px shrink-0 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-fg-muted hover:text-fg-strong data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-fg-strong"
          >
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.key} value={t.key} className="space-y-1">
          <p className="text-xs text-fg-muted">{t.snippet.title}</p>
          {t.snippet.warning ? (
            <p className="text-xs text-warning">{t.snippet.warning}</p>
          ) : null}
          <CodeBlock
            code={t.snippet.code}
            language={t.snippet.language}
            filename={t.snippet.filename}
            copy
          />
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
