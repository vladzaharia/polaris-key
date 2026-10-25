import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, Lock } from "lucide-react";
import type { MintBlock } from "@polaris-key/catalog";
import { type ConfigEntry } from "../../../../api.js";
import { formatDate, fromSeconds } from "../../../../lib/format.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { reads } from "../../../data/reads.js";
import { Button } from "../../../../ui/Button.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Select } from "../../../../ui/Select.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { codecs, useSearchParam } from "../../../router.js";
import { REQUIRES_LABELS } from "../model/edgeMintFields.js";
import { useEdgeMint } from "../data.js";
import {
  blockOf,
  mintEdited,
  withMint,
  MINT_TTL_MAX,
} from "../model/mintBlock.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { AddSigningKey, SigningKeyEmpty, needsKey } from "./RecipeState.js";
import { TTL_PRESETS, previewText, ttlLabel } from "../model/mintView.js";

/** Select values cannot be empty, so "no flag" has one of its own. */
const NO_FLAG = "~none";
const ALGS = ["ES256", "RS256", "EdDSA"] as const;
const REQUIRES = (["licensed", "registered", "none"] as const).map((value) => ({
  value,
  label: REQUIRES_LABELS[value],
}));

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
  productName,
  onChange,
}: {
  entry: ConfigEntry;
  /** The product's name, for "What DJDL receives". */
  productName?: string;
  /** The draft's problem with the recipe, if any. */
  error?: string;
  /** The catalog's flag keys, offered for Required entitlement. */
  flagKeys: string[];
  slug: string;
  onChange: (next: ConfigEntry) => void;
}): React.ReactElement {
  // The stored recipe for this key: `null` when there is none, `undefined` while loading.
  const [, setRecipeId] = useSearchParam("recipe", codecs.string());
  const mint = useEdgeMint(slug);
  const stored = mint.data?.recipes;
  // Until the stored recipe loads the fields stay read-only: a blank form must never be published
  // over it.
  const loadFailed = mint.isError && stored === undefined;
  const locked = mint.isPending || loadFailed;
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

  const edited = mintEdited(entry, recipe);
  const [addingKey, setAddingKey] = React.useState(false);
  const keyless = recipe ? needsKey(recipe) : false;
  const secrets = useQuery({
    ...reads.secrets(slug),
    enabled: recipe?.secretUsage === "edge-mint",
  });
  const sealed = secrets.data?.find((x) => x.name === recipe?.signingKeySecret);
  const entitlements = Array.from(
    new Set([
      ...flagKeys,
      ...(block.requiredEntitlement ? [block.requiredEntitlement] : []),
    ]),
  );
  const approved = recipe?.approval ?? null;
  const ttl = block.ttlSeconds ?? 3600;
  const ttlWas =
    approved && approved.ttlSeconds !== ttl ? approved.ttlSeconds : null;
  const iss =
    typeof block.claimsTemplate?.iss === "string"
      ? block.claimsTemplate.iss
      : "";
  const [nowSec] = React.useState(
    () => Math.floor(Date.now() / 3600000) * 3600,
  );
  const presets = Array.from(new Set<number>([...TTL_PRESETS, ttl])).sort(
    (a, b) => a - b,
  );
  return (
    <div className="space-y-6" data-testid="mint-recipe">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {loadFailed ? (
        <ErrorState
          compact
          error={mint.error}
          onRetry={() => void mint.refetch()}
          context={{ thing: "The stored recipe" }}
        />
      ) : null}
      {recipe?.status === "approved" || recipe === null ? (
        <p className="text-sm text-fg-muted">
          {edited
            ? "Publishing saves this recipe. It signs nothing until you approve it."
            : "Edits publish with the catalog. A changed recipe needs approval again."}
        </p>
      ) : null}
      <section
        aria-label="Recipe"
        className="space-y-4 border-t border-border pt-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            data-recipe-label=""
            tabIndex={-1}
            className="text-base font-semibold text-fg-strong"
          >
            Recipe
          </h3>
          {recipe?.status === "approved" ? (
            <button
              type="button"
              data-recipe-opener=""
              onClick={() => setRecipeId(entry.key)}
              className="inline-flex min-h-6 items-center text-sm text-fg-strong underline underline-offset-2"
            >
              View approval
            </button>
          ) : null}
        </div>
        {locked ? (
          loadFailed ? null : (
            <div className="space-y-3" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          )
        ) : (
          <fieldset className="m-0 min-w-0 space-y-4 border-0 p-0">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <p className="text-sm font-medium text-fg-strong">Recipe id</p>
                <p className="flex items-center gap-2 font-mono text-sm">
                  <Lock aria-hidden className="size-3.5 text-fg-muted" />
                  {entry.key}
                </p>
              </div>
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
                name="mint-iss"
                label="Issuer"
                help="The iss claim."
                optional
                value={iss}
              >
                {(f) => (
                  <Input
                    {...f}
                    value={iss}
                    onChange={(e) => {
                      const next = { ...(block.claimsTemplate ?? {}) };
                      if (e.target.value === "") delete next.iss;
                      else next.iss = e.target.value;
                      setClaimsText(JSON.stringify(next, null, 2));
                      set({ claimsTemplate: next });
                    }}
                  />
                )}
              </FormField>
              <FormField
                name="mint-kid"
                label="Key id"
                help="The kid header."
                optional
                value={block.kid ?? ""}
              >
                {(f) => (
                  <Input
                    {...f}
                    value={block.kid ?? ""}
                    onChange={(e) =>
                      set({ kid: e.target.value.trim() || undefined })
                    }
                  />
                )}
              </FormField>
              <FormField
                name="mint-ttl"
                label="Lifetime"
                help={ttlWas !== null ? `Was ${ttlLabel(ttlWas)}` : undefined}
                value={String(ttl)}
              >
                {(f) => (
                  <Select
                    {...f}
                    className={
                      ttlWas !== null ? "border-warning-border" : undefined
                    }
                    value={String(ttl)}
                    options={presets.map((n) => ({
                      value: String(n),
                      label: ttlLabel(n),
                    }))}
                    onChange={(v) => v && set({ ttlSeconds: Number(v) })}
                  />
                )}
              </FormField>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg-strong">Signing key</p>
              {recipe && keyless ? (
                <SigningKeyEmpty recipe={recipe} />
              ) : recipe?.secretUsage === "edge-mint" ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm">
                  <span className="flex items-center gap-3">
                    <KeyRound aria-hidden className="size-4 text-fg-muted" />
                    <span>
                      <span className="block text-fg-strong">
                        {sealed?.updatedAt
                          ? `Sealed ${formatDate(fromSeconds(sealed.updatedAt))}`
                          : "Sealed"}
                      </span>
                      <span className="block text-fg-muted">
                        Used only for this token
                      </span>
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAddingKey(true)}
                  >
                    Replace key…
                  </Button>
                </div>
              ) : null}
            </div>
            <details className="group text-sm">
              <summary className="flex min-h-6 cursor-pointer items-center gap-1 text-fg-strong underline underline-offset-2">
                More recipe settings
              </summary>
              <div className="mt-3 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
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
                        onChange={(e) =>
                          set({ signingKeySecret: e.target.value.trim() })
                        }
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
                        onChange={(e) =>
                          set({ audience: e.target.value || null })
                        }
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
                            requires:
                              v === "none" || v === "registered"
                                ? v
                                : "licensed",
                          })
                        }
                      />
                    )}
                  </FormField>
                  <FormField
                    name="mint-entitlement"
                    label="Required entitlement"
                    optional
                    help="An entitlement the person's license must include."
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
                          set({
                            requiredEntitlement: v && v !== NO_FLAG ? v : null,
                          })
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
                          set({
                            claimsTemplate: parsed as Record<string, unknown>,
                          });
                        } catch {
                          setClaimsError("Enter a JSON object.");
                        }
                      }}
                    />
                  )}
                </FormField>
              </div>
            </details>
            <div className="space-y-2">
              <p className="text-sm font-medium text-fg-strong">
                What {productName ?? "the app"} receives
              </p>
              <CodeBlock
                code={previewText(block, nowSec, approved?.ttlSeconds ?? null)}
                language="text"
                filename={`${entry.key} · decoded preview`}
              />
            </div>
          </fieldset>
        )}
      </section>
      {recipe ? (
        <AddSigningKey
          slug={slug}
          recipe={recipe}
          replace={!keyless}
          open={addingKey}
          onOpenChange={setAddingKey}
        />
      ) : null}
    </div>
  );
}
