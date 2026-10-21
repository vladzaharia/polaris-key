import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, XCircle } from "lucide-react";
import {
  ApiError,
  type EdgeMintIdentity,
  type EdgeMintRecipe,
  type EdgeMintRecipesResponse,
} from "../../../../api.js";
import { confirmFor } from "../../../../lib/actions.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { codecs, Link, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { stepUpHref, useStepUp } from "../../core/pages/UserRelink.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { useEdgeMint } from "../data.js";
import { mintEdited } from "../model/mintBlock.js";
import { loadDraft } from "../model/catalogDraft.js";
import { focusRecipeAnchor, openerOf } from "../model/recipeFocus.js";
import {
  FieldGrid,
  publicReasons,
  SecretUsage,
  type Field,
} from "./RecipeFields.js";
import {
  FIELD_ORDER,
  fieldsOf,
  IDENTITY_ROWS,
  lifetime,
  show,
  widening,
} from "../model/edgeMintFields.js";

/** The recipe as the operator saw it: any change under it means they have not seen the new one. */
const snapshot = (recipe: EdgeMintRecipe): string =>
  JSON.stringify([fieldsOf(recipe), recipe.changedFields, recipe.status]);

/** "Devices of DJDL with a usable license can then mint…", from who may mint. */
function whoCanMint(
  requires: EdgeMintRecipe["requires"],
  name: string,
  publicMint: boolean,
): string {
  if (requires === "none" || publicMint) return `Anyone who installs ${name}`;
  if (requires === "registered") return `Any device of ${name}`;
  return `Devices of ${name} with a usable license`;
}

/**
 * Where a public mint is turned off. Registration is the derived policy (Services); the other two
 * come from the manifest's autoIssue block, which the console cannot edit.
 */
function PublicFix({
  slug,
  data,
}: {
  slug: string;
  data: EdgeMintRecipesResponse;
}): React.ReactElement {
  const link = "text-fg underline underline-offset-2";
  const manifest = data.anonymousEnroll || data.oidcDefault;
  return (
    <>
      {data.registration === "open" ? (
        <Link to={r.services(slug)} className={link}>
          Change in Features
        </Link>
      ) : null}
      {manifest ? (
        <>
          {data.registration === "open" ? " or in" : "Set in"} the
          manifest&apos;s{" "}
          <a
            className={link}
            href={`${docsUrl("autoIssue")}#auto-issue`}
            target="_blank"
            rel="noreferrer"
          >
            <code className="font-mono text-xs">autoIssue</code> block
            <span className="sr-only"> (opens a new tab)</span>
          </a>
        </>
      ) : null}
    </>
  );
}

/**
 * The approve drawer of a minted token (admin-2-16; P0-12), opened by `?recipe=<key>` on the
 * catalog editor. It compares every security-relevant field with the last approval, changed fields
 * first. The approve route is a step-up: with a sign-in older than five minutes the primary is
 * "Sign in to approve", and a refused check leaves a danger strip in a fixed slot above the foot,
 * the comparison and "Sign in again". A recipe that changes while the drawer is open (a new commit,
 * or a 409 on approve) swaps the comparison under an info callout and approves nothing. Revoking
 * closes the drawer: the operator's own change is not a concurrent one.
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
  const productName = useProduct(slug).data?.name ?? slug;
  const gate = useWriteGate("config", slug);
  const canEdit = gate.allowed;
  const recipe = data?.recipes?.find((x) => x.id === recipeId) ?? null;
  const { fresh, markStale } = useStepUp(open);
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const [refused, setRefused] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [revoking, setRevoking] = React.useState(false);
  const seen = React.useRef<{ id: string; snap: string } | null>(null);
  // Who opened the drawer, read in the first render, before the drawer moves focus.
  const opener = React.useRef<HTMLElement | null>(
    openerOf(document.activeElement),
  );

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
      setRefused(false);
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
  const loadFailed = mint.isError && !data;
  const needsAck = publicMint && !ack;

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
        description: `It mints for ${productName} exactly as shown.`,
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

  const closeAfterRevoke = (): void => {
    // The operator's own change must not read as a concurrent one: leave, and put focus back.
    setRevoking(false);
    onClose();
    focusRecipeAnchor(queryClient, slug, opener.current);
  };

  const fields: { field: Field; moved: boolean }[] = FIELD_ORDER.map(
    (field) => ({ field, moved: changed.has(field) }),
  );
  const hasApproval = recipe?.approval != null;
  const movedRows = fields.filter((f) => f.moved);
  const keptRows = hasApproval ? fields.filter((f) => !f.moved) : [];
  const shownRows = approved ? fields : hasApproval ? movedRows : fields;
  // "Name <email>" reads as the name: the angle brackets reorder inside right-to-left text.
  const approver = recipe?.approval?.approvedBy?.replace(/\s*<[^>]*>\s*$/, "");
  const draftEdited = ((): boolean => {
    const e = loadDraft(slug)?.entries.find((x) => x.key === recipeId);
    return e !== undefined && recipe !== null && mintEdited(e, recipe);
  })();

  const title = loadFailed
    ? "Couldn't load the recipe"
    : recipe
      ? approved
        ? `Recipe ${recipe.id}`
        : canEdit
          ? `Approve ${recipe.id}?`
          : `Recipe ${recipe.id}`
      : mint.isPending
        ? "Recipe"
        : "Recipe not found";
  const description = loadFailed
    ? undefined
    : recipe
      ? approved
        ? "Approved: it mints exactly as shown."
        : !canEdit
          ? "It mints nothing until an editor approves it."
          : `${whoCanMint(recipe.requires, productName, publicMint)} can then mint tokens signed by ${recipe.signingKeySecret}, with exactly these fields.`
      : mint.isPending
        ? "Loading the recipe."
        : "This product has no recipe by that name.";
  const copy = error ? errorCopy(error, { thing: "Recipe" }) : null;
  const reason =
    !recipe || approved
      ? null
      : !canEdit
        ? (gate.disabledReason ??
          "Only members who can edit Managed config can approve.")
        : needsSignIn
          ? refused
            ? null
            : "Approving needs a sign-in from the last five minutes. You come back to this recipe."
          : needsAck
            ? "Tick the box to approve."
            : null;

  return (
    <>
      <Drawer
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        dismissible={!busy}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusRecipeAnchor(queryClient, slug, opener.current);
        }}
        size="lg"
        title={title}
        description={description}
      >
        <DrawerBody>
          {loadFailed ? (
            <ErrorState
              error={mint.error}
              onRetry={() => void mint.refetch()}
              context={{ thing: "The recipe" }}
            />
          ) : mint.isPending ? (
            <div className="space-y-3" aria-busy="true">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : recipe ? (
            <div className="space-y-6">
              {draftEdited ? (
                <Callout tone="info" title="You have unpublished edits">
                  This is the saved recipe. Publish the catalog to include them,
                  then approve.
                </Callout>
              ) : null}
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
                  {approved
                    ? "Approved"
                    : hasApproval
                      ? "What changed"
                      : "Fields"}
                </h3>
                {recipe.approval ? (
                  <p className="text-xs text-fg-muted">
                    <bdi>{approver}</bdi> approved{" "}
                    <Timestamp at={fromSeconds(recipe.approval.approvedAt)} />
                    {approved ? "" : ". Compared with that approval."}
                  </p>
                ) : null}
                {shownRows.length > 0 ? (
                  <FieldGrid recipe={recipe} rows={shownRows} />
                ) : null}
                {keptRows.length > 0 && !approved ? (
                  <details className="group text-sm">
                    <summary className="flex min-h-6 cursor-pointer items-center gap-1 text-fg-muted">
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                      />
                      {keptRows.length}{" "}
                      {keptRows.length === 1 ? "field" : "fields"} unchanged
                    </summary>
                    <div className="mt-1">
                      <FieldGrid recipe={recipe} rows={keptRows} />
                    </div>
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
                      className="text-accent-fg underline underline-offset-2"
                    >
                      Keys &amp; secrets
                    </Link>
                    . Until then the recipe cannot sign, even when approved.
                  </p>
                ) : null}
              </section>

              {wider || changed.has("license") ? (
                <Callout tone="warning" title="This allows more than before">
                  {wider}
                  {changed.has("license")
                    ? " License was turned off since the approval, so the mint no longer checks each device's license: a disabled or expired license would mint again."
                    : null}
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
                      ? " (Identity was off then)."
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
              {!approved && !licenseEnabled && !changed.has("license") ? (
                <p
                  data-testid="edge-mint-approve-license-off"
                  className="text-sm text-warning"
                >
                  License is off: this mint does not check device licenses; a
                  disabled or expired license can mint.
                </p>
              ) : null}
              {!approved && publicMint && data ? (
                <Callout
                  tone="warning"
                  title={`Anyone who installs ${productName} can get one`}
                >
                  <div className="space-y-2">
                    <p>
                      Because {publicReasons(data)}.{" "}
                      <PublicFix slug={slug} data={data} />
                    </p>
                    <Checkbox
                      label={`I understand: anyone who installs the app can get this token, and a leaked one works for ${lifetime(recipe.ttlSeconds)}.`}
                      checked={ack}
                      onCheckedChange={setAck}
                    />
                  </div>
                </Callout>
              ) : null}
            </div>
          ) : null}
        </DrawerBody>
        {refused || copy || reason ? (
          <div
            className="max-h-[40vh] shrink-0 space-y-2 overflow-y-auto border-t border-border px-4 py-3 lg:px-6"
            data-testid="approve-notices"
          >
            {refused ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
              >
                <XCircle
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-danger"
                />
                <div>
                  <p className="font-semibold text-danger">
                    Nothing was approved: the sign-in check didn&apos;t finish.
                  </p>
                  <p className="text-fg">Sign in again, then approve.</p>
                </div>
              </div>
            ) : null}
            {copy ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
              >
                <XCircle
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-danger"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-semibold text-danger">
                    Nothing was approved. {copy.title}.
                  </p>
                  <p className="text-fg">{copy.description}</p>
                  {copy.action === "copy-details" ? (
                    <CopyButton
                      value={JSON.stringify(copy.details, null, 2)}
                      label="Copy details"
                      showLabel
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
            {reason ? (
              <p className="flex items-center gap-2 text-sm text-fg-muted">
                <AlertTriangle aria-hidden className="size-4 shrink-0" />
                {reason}
              </p>
            ) : null}
          </div>
        ) : null}
        <DrawerFooter>
          {recipe?.approval && canEdit ? (
            // The escape hatch sits apart from the primary action, on the far side.
            <Button
              variant="ghost"
              className="text-danger sm:mr-auto"
              disabled={busy}
              onClick={() => setRevoking(true)}
            >
              Revoke approval…
            </Button>
          ) : null}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {approved || !recipe ? "Close" : "Cancel"}
          </Button>
          {recipe && !approved ? (
            canEdit && needsSignIn ? (
              <Button asChild>
                <a href={stepUpHref(returnTo)}>
                  {refused ? "Sign in again" : "Sign in to approve"}
                </a>
              </Button>
            ) : (
              <Button
                loading={busy}
                disabledReason={reason ?? undefined}
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
          closeAfterRevoke();
        }}
      />
    </>
  );
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
