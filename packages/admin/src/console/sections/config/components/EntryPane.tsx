import * as React from "react";
import { Trash2 } from "lucide-react";
import type { ConfigEntry } from "../../../../api.js";
import type { CatalogIssue } from "../../../../schema/index.js";
import { Button } from "../../../../ui/Button.js";
import { Section } from "../../../../ui/Section.js";
import { flagKeysOf, type CatalogDraft } from "../model/catalogDraft.js";
import type { EntryConflict } from "../model/mergeDraft.js";
import { CatalogEntryForm } from "./CatalogEntryForm.js";
import { ConflictPanel } from "./EditorParts.js";
import { MintCards } from "./MintCards.js";
import { useHolders, type Removal } from "./RemovedValues.js";
import { RecipePill, isMinted } from "./RecipeState.js";
import { useEdgeMint } from "../data.js";
import { WhereItsSet } from "./WhereItsSet.js";

/**
 * The open entry as the mockups draw it (config.entry-setting): a card whose head is the key with
 * the draft dot, the form, "Remove from catalog" in its foot, and under it where the key is set.
 */
export function EntryPane({
  slug,
  entry,
  draft,
  issues,
  categories,
  changed,
  conflicts,
  removal,
  productName,
  syncEnabled,
  onSettle,
  onChange,
  onRemove,
}: {
  slug: string;
  entry: ConfigEntry;
  draft: CatalogDraft;
  issues: CatalogIssue[];
  categories: string[];
  /** The entry differs from the published one. */
  changed: boolean;
  conflicts: EntryConflict[];
  removal: Removal | undefined;
  productName?: string;
  syncEnabled: boolean;
  onSettle: (key: string, field: string, take: boolean) => void;
  onChange: (next: ConfigEntry) => void;
  onRemove: () => void;
}): React.ReactElement {
  const minted = isMinted(entry);
  const recipe = useEdgeMint(slug).data?.recipes?.find(
    (x) => x.id === entry.key,
  );
  const base = draft.baseEntries.find((e) => e.key === entry.key);
  const keys = React.useMemo(
    () => (base ? [entry.key] : []),
    [base, entry.key],
  );
  const { byKey } = useHolders(slug, keys);
  // Decided when the entry opens: typing a key that matches a published one must not hide the field.
  const fresh = React.useRef(base === undefined).current;
  return (
    <div className="space-y-6">
      <Section
        variant="settings"
        id="entry-card"
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono text-base">
              {entry.key || "(no key)"}
            </span>
            {changed ? (
              <>
                <span
                  aria-hidden
                  className="size-2 rounded-full bg-fg-strong"
                />
                <span className="sr-only">(changed in this draft)</span>
              </>
            ) : null}
            {minted ? <RecipePill slug={slug} entry={entry} /> : null}
          </span>
        }
        headingLevel={2}
      >
        <div className="space-y-4 p-4">
          {conflicts.map((c) => (
            <ConflictPanel
              key={c.key}
              conflict={c}
              onSettle={(field, take) => onSettle(c.key, field, take)}
            />
          ))}
          <CatalogEntryForm
            entry={entry}
            issues={issues}
            categories={categories}
            fresh={fresh}
            slug={slug}
            syncEnabled={syncEnabled}
            flagKeys={flagKeysOf(draft.entries)}
            baseEntry={base}
            removal={removal}
            holders={byKey[entry.key]}
            productName={productName}
            onChange={onChange}
          />
        </div>
        <div className="border-t border-border px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            iconStart={<Trash2 aria-hidden />}
            onClick={onRemove}
          >
            Remove from catalog
          </Button>
        </div>
      </Section>
      {minted && recipe ? (
        <MintCards slug={slug} keyName={entry.key} recipe={recipe} />
      ) : null}
      {base && !minted ? (
        <WhereItsSet slug={slug} entry={entry} holders={byKey[entry.key]} />
      ) : null}
    </div>
  );
}
