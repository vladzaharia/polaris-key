import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type EdgeMintIdentity,
  type EdgeMintRecipe,
  type EdgeMintRecipesResponse,
} from "../../../../api.js";
import { confirmFor } from "../../../../lib/actions.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { codecs, Link, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { stepUpHref, useStepUp } from "../../core/pages/UserRelink.js";
import { useEdgeMint } from "../data.js";
import {
  changedLabel,
  FIELD_LABELS,
  FIELD_ORDER,
  fieldsOf,
  IDENTITY_ROWS,
  show,
  widening,
} from "../model/edgeMintFields.js";

/** Why the mint is public, in words, from the response's three flags. */
export function publicReasons(data: EdgeMintRecipesResponse): string {
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

export function SecretUsage({
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

/** A field's value; the claims template as a code block. */
function Value({
  field,
  value,
}: {
  field: string;
  value: string | number | null | undefined;
}): React.ReactElement {
  if (field === "claimsTemplateJson" && value !== null && value !== undefined)
    return <CodeBlock code={String(value)} language="json" copy={false} wrap />;
  return <span className="break-all font-mono text-xs">{show(value)}</span>;
}

/** The recipe as the operator saw it: any change under it means they have not seen the new one. */
const snapshot = (recipe: EdgeMintRecipe): string =>
  JSON.stringify([fieldsOf(recipe), recipe.changedFields, recipe.status]);

/**
 * The approve drawer of a minted token (admin-2-16; P0-12), opened by `?recipe=<key>` on the
 * catalog editor. It compares every security-relevant field with the last approval, changed fields
 * first. The approve route is a step-up: with a sign-in older than five minutes the primary is
 * "Sign in to approve", and a refused or abandoned check leaves a danger strip, the comparison and
 * "Try again". A recipe that changes while the drawer is open (a new commit, or a 409 on approve)
 * swaps the comparison under an info callout and approves nothing.
 */
export function ApproveRecipeDrawer({
  slug,
  recipeId,
  onClose,
}: {
  slug: string;
  /** The recipe key from the URL; empty when the drawer is closed. */
  recipeId: string;
  onClose: () => void;
}): React.ReactElement | null {
  const queryClient = useQueryClient();
  const open = recipeId !== "";
  const mint = useEdgeMint(slug, open);
  const data = mint.data;
  const recipe = data?.recipes?.find((x) => x.id === recipeId) ?? null;
  const { fresh, markStale } = useStepUp(open);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const [refused, setRefused] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [revoking, setRevoking] = React.useState(false);
  const seen = React.useRef<{ id: string; snap: string } | null>(null);

  // What the operator has read. A different recipe resets the drawer; the same one with other
  // fields is "changed while you were reviewing".
  React.useEffect(() => {
    if (!recipe) {
      seen.current = null;
      return;
    }
    const snap = snapshot(recipe);
    if (seen.current?.id !== recipe.id) {
      setAck(false);
      setStale(false);
      setRefused(false);
      setError(null);
    } else if (seen.current.snap !== snap) {
      setStale(true);
      setAck(false);
      setError(null);
    }
    seen.current = { id: recipe.id, snap };
  }, [recipe]);

  if (!open) return null;

  const identity: EdgeMintIdentity | null = data?.identity ?? null;
  const licenseEnabled = data?.licenseEnabled !== false;
  const publicMint = data?.publicMint === true;
  const approved = recipe?.status === "approved";
  const changed = new Set(recipe?.changedFields ?? []);
  const wider = recipe ? widening(recipe) : null;
  const returnTo = `${r.catalogEdit(slug)}?entry=${encodeURIComponent(recipeId)}&recipe=${encodeURIComponent(recipeId)}`;
  const needsSignIn = !fresh;

  const approve = async (): Promise<void> => {
    if (!recipe || !data || busy) return;
    setBusy(true);
    setError(null);
    setRefused(false);
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
        // open and reload, so they approve only what they have seen.
        setStale(true);
        setAck(false);
        void queryClient.invalidateQueries({ queryKey: qk.mint(slug) });
      } else if (
        err instanceof ApiError &&
        err.status === 403 &&
        err.code === "step_up_required"
      ) {
        markStale();
        setRefused(true);
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = error ? errorCopy(error, { thing: "Recipe" }) : null;
  const fields = recipe
    ? FIELD_ORDER.map((field) => ({
        field,
        now: recipe[field],
        was: recipe.approval?.[field],
        moved: changed.has(field),
      }))
    : [];
  const movedRows = fields.filter((f) => f.moved);
  const keptRows = recipe?.approval ? fields.filter((f) => !f.moved) : [];
  const shownRows = recipe?.approval ? movedRows : fields;

  return (
    <>
      <Drawer
        open
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
            : mint.isPending
              ? "Recipe"
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
          ) : mint.isPending ? (
            "Loading."
          ) : (
            "This product has no recipe by that name."
          )
        }
      >
        {recipe ? (
          <DrawerBody>
            <div className="space-y-6">
              {stale ? (
                <Callout
                  tone="info"
                  live
                  title="The recipe changed while you were reviewing"
                >
                  Nothing was approved. The comparison below is the new recipe.
                </Callout>
              ) : null}
              <section aria-labelledby="recipe-fields" className="space-y-2">
                <h3
                  id="recipe-fields"
                  className="text-sm font-medium text-fg-strong"
                >
                  {recipe.approval ? "What changed" : "Fields"}
                </h3>
                {recipe.approval ? (
                  <p className="text-xs text-fg-muted">
                    Compared with the approval of{" "}
                    <span className="break-all">
                      {recipe.approval.approvedBy}
                    </span>
                    .
                  </p>
                ) : null}
                {recipe.approval && movedRows.length === 0 ? (
                  <p className="text-sm text-fg-muted">
                    No field changed. {changedLabelList(recipe)}
                  </p>
                ) : null}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sr-only">
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {shownRows.map(({ field, now, was, moved }) => (
                        <tr key={field}>
                          <th
                            scope="row"
                            className="py-1.5 pr-3 font-normal text-fg-muted"
                          >
                            {FIELD_LABELS[field]}
                            {moved ? (
                              <span className="sr-only"> (changed)</span>
                            ) : null}
                          </th>
                          <td className="space-y-1 py-1.5">
                            {moved ? (
                              <div
                                data-testid={`was-${field}`}
                                className="rounded bg-danger-subtle px-1.5 py-0.5 text-danger line-through"
                              >
                                <span aria-hidden="true">− </span>
                                <span className="sr-only">Approved as </span>
                                <Value field={field} value={was} />
                              </div>
                            ) : null}
                            <div
                              className={
                                moved
                                  ? "rounded bg-success-subtle px-1.5 py-0.5 font-semibold text-success"
                                  : undefined
                              }
                            >
                              {moved ? (
                                <>
                                  <span aria-hidden="true">+ </span>
                                  <span className="sr-only">Now </span>
                                </>
                              ) : null}
                              <Value field={field} value={now} />
                            </div>
                            {field === "signingKeySecret" ? (
                              <span className="mt-1 flex">
                                <SecretUsage usage={recipe.secretUsage} />
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {keptRows.length > 0 ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-fg-muted">
                      {keptRows.length}{" "}
                      {keptRows.length === 1 ? "field" : "fields"} unchanged
                    </summary>
                    <dl className="mt-2 divide-y divide-border">
                      {keptRows.map(({ field, now }) => (
                        <div key={field} className="flex gap-3 py-1.5">
                          <dt className="w-40 shrink-0 text-fg-muted">
                            {FIELD_LABELS[field]}
                          </dt>
                          <dd>
                            <Value field={field} value={now} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ) : null}
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

              {wider ? (
                <Callout tone="warning" title="This allows more than before">
                  {wider}
                </Callout>
              ) : null}
              {changed.has("identity") && identity ? (
                <section
                  className="space-y-2"
                  aria-label="Sign-in trust changes"
                >
                  <p className="text-sm text-fg">
                    Sign-in now trusts a different identity provider or group
                    map than when this recipe was approved
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
                  mint no longer checks each device&apos;s license: a disabled
                  or expired license would mint again.
                </p>
              ) : null}
              {changed.has("registration") && data ? (
                <p className="text-sm text-fg">
                  The mint became public ({publicReasons(data)}) after this
                  recipe was approved. Re-approving needs the acknowledgement
                  below.
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
              {!approved && publicMint && data ? (
                <Checkbox
                  label={`I understand ${publicReasons(data)}, so anyone who installs this product can mint this token`}
                  checked={ack}
                  onCheckedChange={setAck}
                />
              ) : null}
              {!approved && needsSignIn && !refused ? (
                <p className="text-sm text-fg-muted">
                  Approving needs a sign-in from the last five minutes. You come
                  back to this recipe.
                </p>
              ) : null}
              {refused || copy ? (
                <div
                  role="alert"
                  className="rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
                >
                  {refused ? (
                    <>
                      <p className="font-semibold text-danger">
                        Nothing was approved: the sign-in check didn&apos;t
                        finish.
                      </p>
                      <p className="text-fg">Sign in again, then approve.</p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold text-danger">{copy!.title}</p>
                      <p className="text-fg">{copy!.description}</p>
                    </>
                  )}
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
              onClick={() => setRevoking(true)}
            >
              Revoke approval…
            </Button>
          ) : null}
          {recipe && !approved ? (
            needsSignIn ? (
              <Button asChild>
                <a href={stepUpHref(returnTo)}>
                  {refused ? "Try again" : "Sign in to approve"}
                </a>
              </Button>
            ) : (
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
            )
          ) : null}
        </DrawerFooter>
      </Drawer>

      <ConfirmDialog
        open={revoking && recipe !== null}
        onOpenChange={(o) => {
          if (!o) setRevoking(false);
        }}
        intent={
          confirmFor("edgeMint.revoke").intent === "caution"
            ? "caution"
            : "danger"
        }
        title={`Revoke the approval of ${recipe?.id ?? ""}?`}
        consequences={[
          "Devices get 404 for this recipe at once, and no new token is minted.",
          "Tokens already issued stay valid until they expire.",
          "It mints again only after it is approved again.",
        ]}
        confirmLabel="Revoke approval"
        describeError={(e) => errorCopy(e, { thing: "Recipe" })}
        onConfirm={async () => {
          const id = recipe!.id;
          try {
            await mutate("revokeEdgeMintRecipe", slug, id);
          } catch (err) {
            void queryClient.invalidateQueries({ queryKey: qk.mint(slug) });
            throw err;
          }
          toast.success(`Revoked the approval of ${id}`, {
            description: "It no longer mints until it is approved again.",
          });
        }}
      />
    </>
  );
}

/** The reasons a recipe's approval no longer applies when no field moved (License, sign-in trust). */
function changedLabelList(recipe: EdgeMintRecipe): string {
  const reasons = recipe.changedFields.map(changedLabel);
  return reasons.length ? `${reasons.join(", ")}.` : "";
}

/** The drawer wherever `?recipe=<key>` is in the URL: one mount for the catalog editor. */
export function ApproveRecipeFromUrl({
  slug,
}: {
  slug: string;
}): React.ReactElement | null {
  const [recipeId, setRecipeId] = useSearchParam("recipe", codecs.string());
  return recipeId ? (
    <ApproveRecipeDrawer
      slug={slug}
      recipeId={recipeId}
      onClose={() => setRecipeId("")}
    />
  ) : null;
}
