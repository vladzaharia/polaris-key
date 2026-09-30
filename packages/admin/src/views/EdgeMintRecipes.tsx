import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  api,
  ApiError,
  type EdgeMintRecipe,
  type EdgeMintRecipeFields,
} from "../api.js";
import { invalidate, useResource } from "../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ConfirmDialog,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Label,
  Skeleton,
  useToast,
} from "../components/ui/index.js";

/**
 * Edge-mint recipe approval (P0-12). A recipe arrives from the product's `.pkey/` manifest, so
 * it is repo-authored; it mints only once an operator has (1) marked its signing secret
 * `edge-mint` and (2) approved the recipe in the exact form it will run. Any push that changes a
 * security-relevant field makes it `changed` — inert until it is approved again.
 *
 * The approve call echoes the fields shown here: if the recipe changed after this view loaded,
 * the server refuses (409) and the operator reloads to see what changed, so they never approve
 * something they did not see.
 *
 * The open-registration acknowledgement is part of the approval too: if the mint becomes public
 * (registration opens, or anonymous enrolment is turned on) after an approval that did not
 * acknowledge it — a push can do either without touching the recipe — the recipe is `changed`
 * with `registration` among its changed fields.
 */

const FIELD_LABELS: Record<keyof EdgeMintRecipeFields, string> = {
  alg: "Algorithm",
  signingKeySecret: "Signing secret",
  kid: "Key id (kid)",
  claimsTemplateJson: "Claims template",
  ttlSeconds: "TTL (seconds)",
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

function show(value: string | number | null): string {
  return value === null ? "—" : String(value);
}

function StatusBadge({
  status,
}: {
  status: EdgeMintRecipe["status"];
}): React.ReactElement {
  if (status === "approved") return <Badge variant="success">Approved</Badge>;
  if (status === "changed")
    return <Badge variant="warning">Changed since approval</Badge>;
  return <Badge variant="warning">Pending approval</Badge>;
}

function UsageBadge({
  usage,
}: {
  usage: EdgeMintRecipe["secretUsage"];
}): React.ReactElement {
  if (usage === "edge-mint") return <Badge variant="success">edge-mint</Badge>;
  if (usage === "missing") return <Badge variant="destructive">not set</Badge>;
  if (usage === "unrecognised")
    return <Badge variant="destructive">unrecognised usage</Badge>;
  return <Badge variant="warning">general — cannot sign</Badge>;
}

/** The recipe's fields; for a changed recipe, the approved value beside each changed one. */
function RecipeFields({
  recipe,
}: {
  recipe: EdgeMintRecipe;
}): React.ReactElement {
  const changed = new Set(recipe.changedFields);
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {FIELD_ORDER.map((field) => {
        const value = recipe[field];
        const was = recipe.approval ? recipe.approval[field] : undefined;
        return (
          <React.Fragment key={field}>
            <dt className="text-muted-foreground">{FIELD_LABELS[field]}</dt>
            <dd className="min-w-0 space-y-1">
              {field === "claimsTemplateJson" && value !== null ? (
                <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
                  {String(value)}
                </pre>
              ) : (
                <span className="break-all font-mono text-xs">
                  {show(value)}
                </span>
              )}
              {field === "signingKeySecret" ? (
                <span className="ml-2 inline-flex">
                  <UsageBadge usage={recipe.secretUsage} />
                </span>
              ) : null}
              {changed.has(field) && was !== undefined ? (
                <p className="break-all text-xs text-warning">
                  approved as: <span className="font-mono">{show(was)}</span>
                </p>
              ) : null}
            </dd>
          </React.Fragment>
        );
      })}
    </dl>
  );
}

export function EdgeMintRecipes({
  slug,
}: {
  slug: string;
}): React.ReactElement | null {
  const { data, loading, error, reload } = useResource(
    `edge-mint:${slug}`,
    () => api.edgeMintRecipes(slug),
  );
  const toast = useToast();
  const [approving, setApproving] = React.useState<EdgeMintRecipe | null>(null);
  const [revoking, setRevoking] = React.useState<EdgeMintRecipe | null>(null);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const open = data?.publicMint === true;
  const anonymousEnroll = data?.anonymousEnroll === true;
  const openReason =
    data?.registration === "open" && anonymousEnroll
      ? "registration is open and anonymous enrolment is on"
      : anonymousEnroll
        ? "anonymous enrolment is on"
        : "registration is open";

  const refresh = (): void => {
    invalidate(`edge-mint:${slug}`);
    invalidate(`product:${slug}`);
  };

  const approve = async (): Promise<void> => {
    if (!approving) return;
    setBusy(true);
    try {
      await api.approveEdgeMintRecipe(
        slug,
        approving.id,
        fieldsOf(approving),
        open && acknowledged,
      );
      toast.success(
        "Recipe approved",
        `“${approving.id}” mints for ${slug} as shown.`,
      );
      setApproving(null);
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? "The recipe changed — review it again"
          : "Couldn’t approve recipe",
        err instanceof Error ? err.message : undefined,
      );
      setApproving(null);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const revoke = async (): Promise<void> => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeEdgeMintRecipe(slug, revoking.id);
      toast.success(
        "Approval revoked",
        `“${revoking.id}” no longer mints until approved again.`,
      );
      setRevoking(null);
    } catch (err) {
      toast.error(
        "Couldn’t revoke approval",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <EmptyState
        icon={<AlertTriangle aria-hidden />}
        title="Couldn’t load edge-mint recipes"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  }
  // A product with no recipes has nothing to approve; the card would be noise.
  if (!data || data.recipes.length === 0) return null;

  return (
    <Card aria-labelledby="edge-mint-title">
      <CardHeader>
        <CardTitle id="edge-mint-title">Edge-mint recipes</CardTitle>
        <CardDescription>
          Recipes come from the product’s <code>.pkey/</code> manifest. A recipe
          mints only when its signing secret is marked <em>edge-mint</em> and an
          operator has approved it exactly as it stands; a push that changes it
          makes it inert until it is approved again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {open ? (
          <div
            role="alert"
            className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 text-warning" />
            <p>
              {data.registration === "open" ? (
                <>
                  Registration for this product is <strong>open</strong>
                  {anonymousEnroll ? " and anonymous enrolment is on" : ""}
                </>
              ) : (
                <>
                  Anonymous enrolment is <strong>on</strong> for this product
                </>
              )}
              : anyone who installs it can hold a device token, so an approved
              recipe is a public token mint.
            </p>
          </div>
        ) : null}
        {data.recipes.map((recipe) => (
          <div
            key={recipe.id}
            className="space-y-3 rounded-md border border-border p-3"
            data-testid={`edge-mint-recipe-${recipe.id}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-medium">
                  {recipe.id}
                </span>
                <StatusBadge status={recipe.status} />
              </div>
              <div className="flex gap-2">
                {recipe.status !== "approved" ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setAcknowledged(false);
                      setApproving(recipe);
                    }}
                  >
                    {recipe.status === "changed" ? "Re-approve" : "Approve"}
                  </Button>
                ) : null}
                {recipe.approval ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRevoking(recipe)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            </div>
            <RecipeFields recipe={recipe} />
            {recipe.changedFields.includes("registration") ? (
              <p className="text-xs text-warning">
                The mint became public ({openReason}) after this recipe was
                approved. It does not mint until it is re-approved with the
                open-registration acknowledgement.
              </p>
            ) : null}
            {recipe.secretUsage !== "edge-mint" ? (
              <p className="text-xs text-muted-foreground">
                Set <span className="font-mono">{recipe.signingKeySecret}</span>{" "}
                above with usage <em>Edge-mint signing key</em>; until then the
                recipe cannot sign even when approved.
              </p>
            ) : null}
          </div>
        ))}
      </CardContent>

      <Dialog
        open={approving !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setApproving(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Approve edge-mint recipe “{approving?.id ?? ""}”?
            </DialogTitle>
            <DialogDescription>
              Every device of {slug} will be able to mint tokens signed by{" "}
              <span className="font-mono">{approving?.signingKeySecret}</span>{" "}
              with exactly these fields.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {approving ? (
              <div className="space-y-4">
                <RecipeFields recipe={{ ...approving, changedFields: [] }} />
                {open ? (
                  <div className="flex items-start gap-2 text-sm">
                    <Checkbox
                      id="edge-mint-ack-open"
                      checked={acknowledged}
                      onCheckedChange={(v) => setAcknowledged(v === true)}
                    />
                    <Label htmlFor="edge-mint-ack-open" className="font-normal">
                      I understand {openReason}, so anyone who installs this
                      product can mint this token.
                    </Label>
                  </div>
                ) : null}
              </div>
            ) : null}
          </DialogBody>
          <DialogActionBar>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setApproving(null)}
            >
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={open && !acknowledged}
              onClick={() => void approve()}
            >
              Approve
            </Button>
          </DialogActionBar>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => {
          if (!o && !busy) setRevoking(null);
        }}
        title={`Revoke approval of “${revoking?.id ?? ""}”?`}
        description="Devices get 404 for this recipe until it is approved again."
        confirmLabel="Revoke"
        loading={busy}
        onConfirm={revoke}
      />
    </Card>
  );
}
