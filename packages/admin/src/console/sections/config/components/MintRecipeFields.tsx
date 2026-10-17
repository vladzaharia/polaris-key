import * as React from "react";
import type { MintBlock } from "@polaris-key/catalog";
import type { ConfigEntry } from "../../../../api.js";
import { Select } from "../../../../ui/Select.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { codecs, useSearchParam } from "../../../router.js";
import { changedLabel } from "../model/edgeMintFields.js";
import { useEdgeMint } from "../data.js";
import { blockOf, withMint, MINT_TTL_MAX } from "../model/mintBlock.js";

/** Select values cannot be empty, so "no flag" has one of its own. */
const NO_FLAG = "~none";
const ALGS = ["ES256", "RS256", "EdDSA"] as const;
const REQUIRES = [
  { value: "licensed", label: "A device with a usable license" },
  { value: "registered", label: "Any device of this product" },
  { value: "none", label: "Anyone" },
];

/**
 * A minted token's recipe, on its entry (U-31): what the Worker signs when the app calls
 * `mintToken(key)`. It shows the recipe as stored until it is edited here; an edit rides the
 * catalog's publish. Approval stays the operator's: a saved or changed recipe signs nothing
 * until it is approved as it stands, so the status sits beside the fields.
 */
export function MintRecipeFields({
  entry,
  flagKeys,
  slug,
  error,
  onChange,
}: {
  entry: ConfigEntry;
  /** The draft's problem with the recipe, if any. */
  error?: string;
  /** The catalog's flag keys, offered for Required entitlement. */
  flagKeys: string[];
  slug: string;
  onChange: (next: ConfigEntry) => void;
}): React.ReactElement {
  // The stored recipe for this key: `null` when there is none, `undefined` while loading.
  const [, setRecipeId] = useSearchParam("recipe", codecs.string());
  const stored = useEdgeMint(slug).data?.recipes;
  const recipe =
    stored === undefined
      ? undefined
      : (stored.find((x) => x.id === entry.key) ?? null);
  const block = blockOf(entry, recipe);
  const set = (patch: Partial<MintBlock>): void =>
    onChange(withMint(entry, { ...block, ...patch }));
  const [claimsText, setClaimsText] = React.useState(() =>
    JSON.stringify(block.claimsTemplate ?? {}, null, 2),
  );
  const [claimsError, setClaimsError] = React.useState<string | null>(null);
  // A recipe that arrives after the form opened fills the box once, unless it was edited.
  const seeded = React.useRef(entry.mint !== undefined);
  React.useEffect(() => {
    if (seeded.current || recipe === undefined || recipe === null) return;
    seeded.current = true;
    setClaimsText(
      JSON.stringify(blockOf(entry, recipe).claimsTemplate ?? {}, null, 2),
    );
  }, [recipe, entry]);

  const edited = entry.mint !== undefined;
  const entitlements = Array.from(
    new Set([
      ...flagKeys,
      ...(block.requiredEntitlement ? [block.requiredEntitlement] : []),
    ]),
  );
  return (
    <div className="space-y-4" data-testid="mint-recipe">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-medium text-fg-strong">Recipe</p>
        {recipe ? (
          <StatusPill domain="edgeMint" state={recipe.status} size="sm" />
        ) : recipe === null ? (
          <span className="text-sm text-fg-muted">Not saved yet</span>
        ) : null}
        {recipe ? (
          <button
            type="button"
            onClick={() => setRecipeId(entry.key)}
            className="text-sm text-accent-fg underline underline-offset-2"
          >
            {recipe.status === "approved"
              ? "View approval"
              : "Review and approve"}
          </button>
        ) : null}
      </div>
      <p className="text-sm text-fg-muted">
        {edited
          ? "Publishing saves this recipe. It signs nothing until you approve it."
          : "Edits publish with the catalog. A changed recipe needs approval again."}
      </p>
      {recipe &&
      recipe.status === "changed" &&
      recipe.changedFields.length > 0 ? (
        <p role="status" className="text-sm text-warning">
          Changed since approval:{" "}
          {recipe.changedFields.map(changedLabel).join(", ")}.
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="mint-alg" label="Algorithm" value={block.alg}>
          {(f) => (
            <Select
              {...f}
              value={block.alg}
              options={ALGS.map((a) => ({ value: a, label: a }))}
              onChange={(alg) => alg && set({ alg })}
            />
          )}
        </FormField>
        <FormField
          name="mint-secret"
          label="Signing secret"
          help="The product secret that holds the key. Set it in Keys and secrets."
          value={block.signingKeySecret}
          required
        >
          {(f) => (
            <Input
              {...f}
              value={block.signingKeySecret}
              placeholder="APPLE_MUSIC_KEY"
              onChange={(e) => set({ signingKeySecret: e.target.value.trim() })}
            />
          )}
        </FormField>
        <FormField
          name="mint-kid"
          label="Key id"
          optional
          value={block.kid ?? ""}
        >
          {(f) => (
            <Input
              {...f}
              value={block.kid ?? ""}
              onChange={(e) => set({ kid: e.target.value.trim() || undefined })}
            />
          )}
        </FormField>
        <FormField
          name="mint-audience"
          label="Audience"
          optional
          value={block.audience ?? ""}
        >
          {(f) => (
            <Input
              {...f}
              value={block.audience ?? ""}
              onChange={(e) => set({ audience: e.target.value || null })}
            />
          )}
        </FormField>
        <FormField
          name="mint-ttl"
          label="Lifetime (seconds)"
          help={`Up to ${MINT_TTL_MAX}.`}
          optional
          value={String(block.ttlSeconds ?? "")}
        >
          {(f) => (
            <Input
              {...f}
              inputMode="numeric"
              value={
                block.ttlSeconds === undefined ? "" : String(block.ttlSeconds)
              }
              onChange={(e) => {
                const n = Number(e.target.value);
                set({
                  ttlSeconds:
                    e.target.value.trim() === "" || !Number.isFinite(n)
                      ? undefined
                      : n,
                });
              }}
            />
          )}
        </FormField>
        <FormField
          name="mint-requires"
          label="Who may mint"
          value={block.requires ?? "licensed"}
        >
          {(f) => (
            <Select
              {...f}
              value={block.requires ?? "licensed"}
              options={REQUIRES}
              onChange={(v) =>
                set({
                  requires: v === "none" || v === "registered" ? v : "licensed",
                })
              }
            />
          )}
        </FormField>
        <FormField
          name="mint-entitlement"
          label="Required flag"
          optional
          help="A flag the person's license must include."
          value={block.requiredEntitlement ?? ""}
        >
          {(f) => (
            <Select
              {...f}
              value={block.requiredEntitlement ?? NO_FLAG}
              options={[
                { value: NO_FLAG, label: "None" },
                ...entitlements.map((k) => ({ value: k, label: k })),
              ]}
              onChange={(v) =>
                set({ requiredEntitlement: v && v !== NO_FLAG ? v : null })
              }
            />
          )}
        </FormField>
      </div>
      <FormField
        name="mint-claims"
        label="Claims template (JSON)"
        optional
        error={claimsError ?? undefined}
        announceError
        value={claimsText}
      >
        {(f) => (
          <Textarea
            {...f}
            rows={4}
            className="font-mono text-xs"
            value={claimsText}
            onChange={(e) => {
              const text = e.target.value;
              setClaimsText(text);
              try {
                const parsed: unknown =
                  text.trim() === "" ? {} : JSON.parse(text);
                if (
                  parsed === null ||
                  typeof parsed !== "object" ||
                  Array.isArray(parsed)
                )
                  throw new Error("object");
                setClaimsError(null);
                set({ claimsTemplate: parsed as Record<string, unknown> });
              } catch {
                setClaimsError("Enter a JSON object.");
              }
            }}
          />
        )}
      </FormField>
    </div>
  );
}
