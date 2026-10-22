import * as React from "react";
import type { ConfigEntry } from "../../../../api.js";
import { inAppLabel, typeLabel } from "../../../../lib/labels.js";
import {
  UNCATEGORISED,
  categoryLabel,
  formatValue,
  schemaSummary,
} from "../../../../schema/index.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Drawer, DrawerBody } from "../../../../ui/Drawer.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { EntityLink } from "../../../components/EntityLink.js";
import { useCatalogUsage } from "../data.js";
import { defaultText, retiredNotes } from "../model/entryNotes.js";
import { RecipeApproval } from "./RecipeState.js";

/** The key drawer of the catalog table: the entry's facts and what overrides it (A-7b). */
export function KeyDrawer({
  slug,
  entry,
  onClose,
}: {
  slug: string;
  entry: ConfigEntry | null;
  onClose: () => void;
}): React.ReactElement {
  const usage = useCatalogUsage(slug, entry ? [entry.key] : []);
  const used = entry ? usage.data?.keys[entry.key] : undefined;
  const ui = entry?.ui;
  return (
    <Drawer
      open={entry !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="lg"
      title={entry?.label ?? "Key"}
      description={
        entry ? <code className="font-mono text-xs">{entry.key}</code> : null
      }
    >
      {entry ? (
        <DrawerBody>
          <div className="space-y-6">
            {entry.description ? (
              <p className="text-sm text-fg">{entry.description}</p>
            ) : null}
            <RecipeApproval slug={slug} entry={entry} />
            <DescriptionList
              columns={2}
              items={[
                {
                  term: "Type",
                  detail: typeLabel(entry),
                },
                {
                  term: "Category",
                  detail: categoryLabel(entry.category || UNCATEGORISED),
                },
                { term: "Schema", detail: schemaSummary(entry.schema) },
                {
                  term: "Default",
                  detail:
                    defaultText(entry) ??
                    `${formatValue(entry.default)}${ui?.unit && entry.default !== undefined ? ` ${ui.unit}` : ""}`,
                },
                // Only the fields that apply to this kind of key.
                ...(entry.kind !== "flag"
                  ? [{ term: "In the app", detail: inAppLabel(entry) }]
                  : []),
                ...(entry.kind === "flag"
                  ? [
                      {
                        term: "Given to user",
                        detail: entry.userGrant
                          ? (entry.grantLabel ?? "Yes")
                          : "No",
                      },
                    ]
                  : []),
                ...(entry.accessor
                  ? [{ term: "Accessor", detail: entry.accessor }]
                  : []),
                ...(retiredNotes(entry).length
                  ? [
                      {
                        term: "Retired",
                        detail: (
                          <ul className="space-y-1 text-warning">
                            {retiredNotes(entry).map((n) => (
                              <li key={n}>{n}</li>
                            ))}
                          </ul>
                        ),
                      },
                    ]
                  : []),
                ...(entry.dependsOn
                  ? [
                      {
                        term: "Shown when",
                        detail: `${entry.dependsOn.key} = ${formatValue(entry.dependsOn.equals)}`,
                      },
                    ]
                  : []),
                ...(entry.appliesTo
                  ? [
                      {
                        term: "Applies to",
                        detail: ([] as string[])
                          .concat(entry.appliesTo as string | string[])
                          .join(", "),
                      },
                    ]
                  : []),
                ...(ui?.widget ? [{ term: "Widget", detail: ui.widget }] : []),
                ...(ui?.help ? [{ term: "Help", detail: ui.help }] : []),
                ...(ui?.advanced
                  ? [{ term: "Shown under", detail: "More settings" }]
                  : []),
              ]}
            />
            <CodeBlock
              code={JSON.stringify(entry.schema, null, 2)}
              language="json"
              filename="Schema"
            />
            <section className="space-y-2" aria-labelledby="overridden-by">
              <h3
                id="overridden-by"
                className="text-sm font-medium text-fg-strong"
              >
                Overridden by
              </h3>
              {usage.isPending ? (
                <p className="text-sm text-fg-muted">Loading…</p>
              ) : usage.error ? (
                <ErrorState
                  compact
                  error={usage.error}
                  onRetry={() => void usage.refetch()}
                />
              ) : used &&
                (used.profiles.length ||
                  used.tiers.length ||
                  used.licenses.length ||
                  used.accounts?.length) ? (
                <DescriptionList
                  items={[
                    {
                      term: "Profiles",
                      detail: used.profiles.length ? (
                        <LinkList>
                          {used.profiles.map((p) => (
                            <EntityLink
                              key={p.id}
                              slug={slug}
                              kind="profile"
                              id={p.id}
                              label={p.name || p.id}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                    {
                      term: "Tiers (through their profile)",
                      detail: used.tiers.length ? (
                        <LinkList>
                          {used.tiers.map((t) => (
                            <EntityLink
                              key={t.id}
                              slug={slug}
                              kind="tier"
                              id={t.id}
                              label={`${t.label || t.id} (via ${t.profile})`}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                    {
                      term: "Licenses",
                      detail: used.licenses.length ? (
                        <LinkList>
                          {used.licenses.map((l) => (
                            <EntityLink
                              key={l.id}
                              slug={slug}
                              kind="license"
                              id={l.id}
                              label={l.name || l.email || l.id}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                    {
                      // U-03: account overrides, by the product's pairwise subject.
                      term: "Accounts (account overrides)",
                      detail: used.accounts?.length ? (
                        <LinkList>
                          {used.accounts.map((a) => (
                            <EntityLink
                              key={a.subject}
                              slug={slug}
                              kind="user"
                              id={a.subject}
                            />
                          ))}
                        </LinkList>
                      ) : (
                        "None"
                      ),
                    },
                  ]}
                />
              ) : (
                <p className="text-sm text-fg-muted">
                  No profile, license or account sets this key; clients use the
                  default.
                </p>
              )}
            </section>
          </div>
        </DrawerBody>
      ) : null}
    </Drawer>
  );
}

function LinkList({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {React.Children.map(children, (c) => (
        <li>{c}</li>
      ))}
    </ul>
  );
}
