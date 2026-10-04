import * as React from "react";
import {
  ApiError,
  type EdgeMintIdentity,
  type EdgeMintRecipe,
  type EdgeMintRecipeFields,
  type EdgeMintRecipesResponse,
} from "../../../api.js";
import { invalidate } from "../../../context.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { CodeBlock } from "../../../ui/CodeBlock.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import {
  DataTable,
  type DataColumn,
  type Facet,
} from "../../../ui/data-table/index.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { PageHeader } from "../../components/PageHeader.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { codecs, Link, useLocation, useSearchParam } from "../../router.js";
import { r, withParam } from "../../routes.js";
import { CollectionTemplate } from "../../templates/Collection.js";
import { useTableUrlState } from "../../useTableUrlState.js";
import { useEdgeMint } from "./data.js";

const RECIPE = codecs.string();

const FIELD_LABELS: Record<keyof EdgeMintRecipeFields, string> = {
  alg: "Algorithm",
  signingKeySecret: "Signing secret",
  kid: "Key id (kid)",
  claimsTemplateJson: "Claims template",
  ttlSeconds: "Token lifetime (seconds)",
  audience: "Audience",
};

const FIELD_ORDER: (keyof EdgeMintRecipeFields)[] = [
  "alg",
  "signingKeySecret",
  "kid",
  "audience",
  "ttlSeconds",
  "claimsTemplateJson",
];

const REASON_LABELS: Record<string, string> = {
  registration: "Registration opened",
  license: "License turned off",
  identity: "Sign-in trust changed",
};

const IDENTITY_ROWS: [string, keyof EdgeMintIdentity][] = [
  ["Provider", "provider"],
  ["Issuer", "issuer"],
  ["Client id", "clientId"],
  ["Group map", "groupRoleMapJson"],
];

function fieldsOf(recipe: EdgeMintRecipeFields): EdgeMintRecipeFields {
  return {
    alg: recipe.alg,
    signingKeySecret: recipe.signingKeySecret,
    kid: recipe.kid,
    claimsTemplateJson: recipe.claimsTemplateJson,
    ttlSeconds: recipe.ttlSeconds,
    audience: recipe.audience,
  };
}

const show = (value: string | number | null | undefined): string =>
  value === null || value === undefined ? "—" : String(value);

function changedLabel(field: EdgeMintRecipe["changedFields"][number]): string {
  return (
    REASON_LABELS[field] ??
    FIELD_LABELS[field as keyof EdgeMintRecipeFields] ??
    field
  );
}

/** Why the mint is public, in words, from the response's three flags. */
function publicReasons(data: EdgeMintRecipesResponse): string {
  const reasons = [
    ...(data.registration === "open" ? ["registration is open"] : []),
    ...(data.anonymousEnroll ? ["anonymous enrollment is on"] : []),
    ...(data.oidcDefault
      ? ["every account that can sign in gets a default tier"]
      : []),
  ];
  if (reasons.length > 1)
    return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
  return reasons[0] ?? "registration is open";
}

function SecretUsage({
  usage,
}: {
  usage: EdgeMintRecipe["secretUsage"];
}): React.ReactElement {
  if (usage === "edge-mint")
    return (
      <StatusPill tone="success" size="sm">
        Marked edge-mint
      </StatusPill>
    );
  if (usage === "missing")
    return (
      <StatusPill tone="danger" size="sm">
        Not set
      </StatusPill>
    );
  if (usage === "unrecognised")
    return (
      <StatusPill tone="danger" size="sm">
        Unrecognised usage
      </StatusPill>
    );
  return (
    <StatusPill tone="warning" size="sm">
      General: cannot sign
    </StatusPill>
  );
}

function IdentityList({
  identity,
}: {
  identity: EdgeMintIdentity;
}): React.ReactElement {
  return (
    <DescriptionList
      columns={2}
      items={IDENTITY_ROWS.map(([term, key]) => ({
        term,
        detail: (
          <span className="font-mono text-xs [overflow-wrap:anywhere]">
            {show(identity[key])}
          </span>
        ),
      }))}
    />
  );
}

/**
 * Config → Edge mint (docs/design/ADMIN.md §6.6.4, T2). Recipes come from the product's
 * `.pkey/release`; a recipe mints only once its signing secret is marked edge-mint and an operator
 * approved it exactly as it stands.
 *
 * - Always present: with no recipes, the first-run state explains them (EMR-1).
 * - Approved / Needs approval / Changed since approval each have their own tone and icon; the
 *   page's warnings are static callouts, never re-announced alerts (EMR-2).
 * - Approve is a drawer: the fields read-only against the last approval, the public-mint
 *   acknowledgement when it applies, Approve (L1). A 409 keeps the drawer open and reloads the
 *   recipe (EMR-3). Revoke approval is L2.
 * - The sign-in trust shows once, in the page header (EMR-4); the signing secret links to Keys &
 *   secrets (EMR-5).
 */
export function EdgeMintPage({ slug }: { slug: string }): React.ReactElement {
  const mint = useEdgeMint(slug);
  const [state, setState] = useTableUrlState("edge-mint", {
    facets: ["status"],
  });
  const [recipeId, setRecipeId] = useSearchParam("recipe", RECIPE);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const { route } = useLocation();

  const recipes = React.useMemo(() => mint.data?.recipes ?? [], [mint.data]);

  const recipeHref = React.useCallback(
    (id: string) => {
      const q = withParam(route.query, "recipe", RECIPE, id).toString();
      return `${r.edgeMint(slug)}${q ? `?${q}` : ""}`;
    },
    [route.query, slug],
  );

  const columns = React.useMemo<DataColumn<EdgeMintRecipe>[]>(
    () => [
      {
        id: "id",
        header: "Recipe",
        accessorKey: "id",
        meta: { priority: 1, primary: true, mono: true, alwaysVisible: true },
        cell: ({ getValue }) => (
          <span
            className="block max-w-[12rem] truncate"
            title={getValue() as string}
          >
            {getValue() as string}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorKey: "status",
        meta: { priority: 1 },
        cell: ({ row }) => (
          <StatusPill domain="edgeMint" state={row.original.status} />
        ),
      },
      {
        id: "secret",
        header: "Signing secret",
        accessorFn: (e) => `${e.signingKeySecret} ${e.secretUsage}`,
        meta: {
          priority: 2,
          label: "Signing secret",
          csv: (e) => e.signingKeySecret,
        },
        cell: ({ row }) => (
          <span className="flex flex-col items-start gap-1">
            <Link
              to={r.keys(slug)}
              title={row.original.signingKeySecret}
              className="block max-w-[14rem] truncate font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
            >
              {row.original.signingKeySecret}
            </Link>
            <SecretUsage usage={row.original.secretUsage} />
          </span>
        ),
      },
      {
        id: "changed",
        header: "Changed since approval",
        accessorFn: (e) => e.changedFields.map(changedLabel).join(", "),
        enableSorting: false,
        meta: { priority: 2 },
        cell: ({ row }) =>
          row.original.changedFields.length ? (
            // One line per row: the count, with the reasons on hover and for AT.
            <span
              className="block max-w-[11rem] truncate text-xs"
              title={row.original.changedFields.map(changedLabel).join(", ")}
            >
              {row.original.changedFields.map(changedLabel).join(", ")}
            </span>
          ) : (
            <span className="text-fg-muted">—</span>
          ),
      },
      {
        id: "approved",
        header: "Approved",
        accessorFn: (e) => e.approval?.approvedAt ?? 0,
        meta: {
          priority: 3,
          csv: (e) => e.approval?.approvedBy ?? "",
        },
        cell: ({ row }) =>
          row.original.approval ? (
            <span className="flex flex-col text-xs">
              <span className="whitespace-nowrap">
                <Timestamp at={fromSeconds(row.original.approval.approvedAt)} />
              </span>
              <span
                className="block max-w-[12rem] truncate text-fg-muted"
                title={row.original.approval.approvedBy}
              >
                {row.original.approval.approvedBy}
              </span>
            </span>
          ) : (
            <span className="text-fg-muted">Never</span>
          ),
      },
    ],
    [slug],
  );

  const facets = React.useMemo<Facet<EdgeMintRecipe>[]>(
    () => [
      {
        id: "status",
        label: "Status",
        options: [
          { value: "approved", label: "Approved" },
          { value: "pending", label: "Needs approval" },
          { value: "changed", label: "Changed since approval" },
        ],
      },
    ],
    [],
  );

  if (mint.isPending)
    return <PageSkeleton template="table" label="edge-mint recipes" />;

  const data = mint.data;
  const header = (
    <PageHeader
      title="Edge mint"
      titleAside={
        data ? (
          <span className="text-sm text-fg-muted">{recipes.length}</span>
        ) : null
      }
      refetching={mint.isFetching && !mint.isPending}
    />
  );

  if (mint.error || !data) {
    return (
      <CollectionTemplate header={header}>
        <ErrorState
          error={mint.error}
          onRetry={() => void mint.refetch()}
          context={{ thing: "Edge-mint recipes" }}
        />
      </CollectionTemplate>
    );
  }

  const approving = recipes.find((x) => x.id === recipeId) ?? null;
  const revokeTarget = recipes.find((x) => x.id === revoking) ?? null;

  return (
    <CollectionTemplate header={header}>
      {recipes.length > 0 ? (
        <div className="space-y-3">
          {data.publicMint || !data.licenseEnabled ? (
            // One warning, however many reasons: the reasons are its bullets.
            <Callout
              tone="warning"
              title={data.publicMint ? "The mint is public" : "License is off"}
            >
              <ul className="list-disc space-y-1 pl-5">
                {data.publicMint ? (
                  <li>
                    Because {publicReasons(data)}, anyone who installs this
                    product (or can sign in to it) can hold a device token, so
                    an approved recipe is a public token mint. Approving one
                    needs your acknowledgement.
                  </li>
                ) : null}
                {!data.licenseEnabled ? (
                  <li data-testid="edge-mint-license-off">
                    The mint does not check device licenses, so a disabled or
                    expired license can mint. An approval given now records
                    that; turning License on later only narrows it.
                  </li>
                ) : null}
              </ul>
            </Callout>
          ) : null}
        </div>
      ) : null}

      <DataTable<EdgeMintRecipe>
        id="edge-mint"
        caption="Edge-mint recipes"
        mobile="cards"
        data={recipes}
        columns={columns}
        getRowId={(e) => e.id}
        rowLabel={(e) => e.id}
        rowHref={(e) => recipeHref(e.id)}
        linkComponent={Link}
        facets={facets}
        search={{ placeholder: "Search recipes…", columns: ["id", "secret"] }}
        state={state}
        onStateChange={setState}
        exportCsv={false}
        rowActions={(e) => [
          {
            label:
              e.status === "approved"
                ? "Review…"
                : e.status === "changed"
                  ? "Re-approve…"
                  : "Approve…",
            onSelect: () => setRecipeId(e.id),
          },
          ...(e.approval
            ? [
                { type: "separator" as const },
                {
                  label: "Revoke approval…",
                  tone: "danger" as const,
                  onSelect: () => setRevoking(e.id),
                },
              ]
            : []),
        ]}
        empty={
          <EmptyState
            kind="first-run"
            title="No edge-mint recipes"
            description="Recipes declared in the product's .pkey/release appear here for approval."
            docs="/docs/services/config/edge-mint/"
          />
        }
      />

      {recipes.length > 0 && data.identity ? (
        <details className="rounded-lg border border-border bg-surface-raised px-4 py-3 text-sm">
          <summary className="cursor-pointer font-bold text-fg-strong">
            Signing in also hands out device tokens
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-fg-muted">
              An approval covers this identity provider and group map; when they
              change, every recipe stops minting until it is approved again. Set
              them in{" "}
              <Link
                to={r.portal(slug)}
                className="text-accent-fg underline-offset-4 hover:underline"
              >
                Identity
              </Link>
              .
            </p>
            <IdentityList identity={data.identity} />
          </div>
        </details>
      ) : null}

      <ApproveDrawer
        slug={slug}
        data={data}
        recipe={approving}
        open={recipeId !== ""}
        onClose={() => setRecipeId("")}
        onRevoke={(id) => setRevoking(id)}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRevoking(null);
        }}
        intent={
          confirmFor("edgeMint.revoke").intent === "caution"
            ? "caution"
            : "danger"
        }
        title={`Revoke the approval of ${revokeTarget?.id ?? ""}?`}
        consequences={[
          "Devices get 404 for this recipe at once, and no new token is minted.",
          "Tokens already issued stay valid until they expire.",
          "It mints again only after it is approved again.",
        ]}
        confirmLabel="Revoke approval"
        describeError={(e) => errorCopy(e, { thing: "Recipe" })}
        onConfirm={async () => {
          const id = revokeTarget!.id;
          try {
            await mutate("revokeEdgeMintRecipe", slug, id);
          } catch (err) {
            invalidate(qk.mint(slug));
            throw err;
          }
          toast.success(`Revoked the approval of ${id}`, {
            description: "It no longer mints until it is approved again.",
          });
        }}
      />
    </CollectionTemplate>
  );
}

function ApproveDrawer({
  slug,
  data,
  recipe,
  open,
  onClose,
  onRevoke,
}: {
  slug: string;
  data: EdgeMintRecipesResponse;
  recipe: EdgeMintRecipe | null;
  open: boolean;
  onClose: () => void;
  onRevoke: (id: string) => void;
}): React.ReactElement {
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const lastId = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (recipe?.id !== lastId.current) {
      lastId.current = recipe?.id ?? null;
      setAck(false);
      setStale(false);
      setError(null);
    }
  }, [recipe?.id]);

  const identity = data.identity;
  const licenseEnabled = data.licenseEnabled !== false;
  const publicMint = data.publicMint === true;
  const approved = recipe?.status === "approved";
  const changed = new Set(recipe?.changedFields ?? []);

  const approve = async (): Promise<void> => {
    if (!recipe || busy) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(
        "approveEdgeMintRecipe",
        slug,
        recipe.id,
        fieldsOf(recipe),
        identity,
        licenseEnabled,
        publicMint && ack,
      );
      toast.success(`Approved ${recipe.id}`, {
        description: `It mints for ${slug} exactly as shown.`,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // The recipe, its sign-in trust or License moved while the operator was reading: stay
        // open and reload, so they approve only what they have seen (EMR-3).
        setStale(true);
        setAck(false);
        invalidate(qk.mint(slug));
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = error ? errorCopy(error, { thing: "Recipe" }) : null;

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      dismissible={!busy}
      size="lg"
      title={
        recipe
          ? approved
            ? `Recipe ${recipe.id}`
            : `Approve ${recipe.id}?`
          : "Recipe not found"
      }
      description={
        recipe ? (
          approved ? (
            "Approved: it mints exactly as shown."
          ) : (
            <>
              Every device of {slug} will be able to mint tokens signed by{" "}
              <code className="font-mono text-xs">
                {recipe.signingKeySecret}
              </code>{" "}
              with exactly these fields.
            </>
          )
        ) : (
          "The link names a recipe this product does not declare."
        )
      }
    >
      {recipe ? (
        <DrawerBody>
          <div className="space-y-6">
            {stale ? (
              <Callout
                tone="warning"
                live
                title="This recipe changed while you were reviewing"
              >
                The fields below are reloaded. Review them again before you
                approve.
              </Callout>
            ) : null}
            <section aria-labelledby="recipe-fields" className="space-y-2">
              <h3
                id="recipe-fields"
                className="text-sm font-bold text-fg-strong"
              >
                Fields
              </h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-fg-muted">
                    <tr>
                      <th scope="col" className="py-1 pr-3 font-normal">
                        Field
                      </th>
                      <th scope="col" className="py-1 pr-3 font-normal">
                        Now
                      </th>
                      {recipe.approval ? (
                        <th scope="col" className="py-1 font-normal">
                          Approved as
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {FIELD_ORDER.map((field) => {
                      const now = recipe[field];
                      const was = recipe.approval?.[field];
                      const moved = changed.has(field);
                      return (
                        <tr
                          key={field}
                          className={moved ? "bg-warning-subtle" : undefined}
                        >
                          <th
                            scope="row"
                            className="py-1.5 pr-3 align-top font-normal text-fg-muted"
                          >
                            {FIELD_LABELS[field]}
                            {moved ? (
                              <span className="sr-only"> (changed)</span>
                            ) : null}
                          </th>
                          <td className="py-1.5 pr-3 align-top">
                            {field === "claimsTemplateJson" && now !== null ? (
                              <CodeBlock
                                code={String(now)}
                                language="json"
                                copy={false}
                                wrap
                              />
                            ) : (
                              <span className="break-all font-mono text-xs">
                                {show(now)}
                              </span>
                            )}
                            {field === "signingKeySecret" ? (
                              <span className="mt-1 flex">
                                <SecretUsage usage={recipe.secretUsage} />
                              </span>
                            ) : null}
                          </td>
                          {recipe.approval ? (
                            <td className="py-1.5 align-top">
                              <span
                                className={
                                  moved
                                    ? "break-all font-mono text-xs text-warning"
                                    : "break-all font-mono text-xs text-fg-muted"
                                }
                              >
                                {show(was)}
                              </span>
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {recipe.secretUsage !== "edge-mint" ? (
                <p className="text-sm text-fg-muted">
                  Mark{" "}
                  <code className="font-mono text-xs">
                    {recipe.signingKeySecret}
                  </code>{" "}
                  as an edge-mint signing key in{" "}
                  <Link
                    to={r.keys(slug)}
                    className="text-accent-fg underline-offset-4 hover:underline"
                  >
                    Keys &amp; secrets
                  </Link>
                  . Until then the recipe cannot sign, even when approved.
                </p>
              ) : null}
            </section>

            {changed.has("identity") && identity ? (
              <section className="space-y-2" aria-label="Sign-in trust changes">
                <p className="text-sm text-fg">
                  Sign-in now trusts a different identity provider or group map
                  than when this recipe was approved
                  {recipe.approval?.identity === null
                    ? ", which was approved while Identity was off."
                    : "."}
                </p>
                <DescriptionList
                  columns={2}
                  items={IDENTITY_ROWS.map(([term, key]) => {
                    const was = recipe.approval?.identity;
                    return {
                      term,
                      detail: (
                        <span className="font-mono text-xs [overflow-wrap:anywhere]">
                          {show(identity[key])}
                        </span>
                      ),
                      help:
                        was === undefined || was === null
                          ? undefined
                          : was[key] !== identity[key]
                            ? `Approved as ${show(was[key])}`
                            : undefined,
                    };
                  })}
                />
              </section>
            ) : null}
            {changed.has("license") ? (
              <p className="text-sm text-fg">
                License was turned off after this recipe was approved, so the
                mint no longer checks each device&apos;s license: a disabled or
                expired license would mint again.
              </p>
            ) : null}
            {changed.has("registration") ? (
              <p className="text-sm text-fg">
                The mint became public ({publicReasons(data)}) after this recipe
                was approved. Re-approving needs the acknowledgement below.
              </p>
            ) : null}
            {!approved && !licenseEnabled ? (
              <p
                data-testid="edge-mint-approve-license-off"
                className="text-sm text-warning"
              >
                License is off: this mint does not check device licenses; a
                disabled or expired license can mint.
              </p>
            ) : null}
            {!approved && publicMint ? (
              <Checkbox
                label={`I understand ${publicReasons(data)}, so anyone who installs this product can mint this token`}
                checked={ack}
                onCheckedChange={setAck}
              />
            ) : null}
            {copy ? (
              <div
                role="alert"
                className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
              >
                <p className="font-bold text-danger">{copy.title}</p>
                <p className="text-fg">{copy.description}</p>
              </div>
            ) : null}
          </div>
        </DrawerBody>
      ) : null}
      <DrawerFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {approved || !recipe ? "Close" : "Cancel"}
        </Button>
        {recipe?.approval ? (
          // The escape hatch sits apart from the primary action, on the far side.
          <Button
            variant="ghost"
            className="text-danger sm:mr-auto sm:order-first"
            disabled={busy}
            onClick={() => onRevoke(recipe.id)}
          >
            Revoke approval…
          </Button>
        ) : null}
        {recipe && !approved ? (
          <Button
            loading={busy}
            disabledReason={
              publicMint && !ack
                ? "Tick the acknowledgement above first."
                : undefined
            }
            onClick={() => void approve()}
          >
            {recipe.status === "changed" ? "Re-approve" : "Approve"}
          </Button>
        ) : null}
      </DrawerFooter>
    </Drawer>
  );
}
