/**
 * Link repository (EXPERIENCE.md §0.4 S1, AS 1.5): hands a product that exists already over to
 * its repository's `.pkey/` manifest. Opened from Settings → Repository and from the Releases
 * first-release panel, so both places link the same way.
 *
 * Two steps in one drawer (worker `release/linkExisting.ts`):
 *
 *   1. **Check** runs the link's checks (repository, the Polaris Key GitHub App, the manifest, its
 *      slug) and returns the plan: what the manifest applies, what stays because it was set in
 *      the console, what it removes and what blocks the link. Nothing is written.
 *   2. **Link repository** sends the check's manifest digest back, so a push in between refuses
 *      ("check again") instead of applying a manifest nobody read. Editing the repository field
 *      after a check clears it.
 */

import * as React from "react";
import { GitBranch } from "lucide-react";
import {
  ApiError,
  type LinkCheckResult,
  type LinkExistingResult,
  type ManifestPlanItem,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { toast } from "../../../../ui/toast.js";
import { CheckRow, type RowState } from "../../../components/CheckRow.js";
import { mutate } from "../../../data/mutations.js";

/** The checks, in the order the worker runs them (its refusal `reason` names one). */
const CHECKS = ["repository", "app", "manifest", "slug", "policy"] as const;
type CheckId = (typeof CHECKS)[number];

interface Refusal {
  check: CheckId | "product" | "changed";
  title: string;
  description: string;
  problems: string[];
}

/** Word a refusal for the check it failed. Unknown shapes fall back to `errorCopy`. */
export function linkRefusal(
  error: unknown,
  ctx: { slug: string; repository: string },
): Refusal {
  const api = error instanceof ApiError ? error : null;
  const message =
    api?.message && api.message !== `api ${api.status}` ? api.message : "";
  const problems = api?.errors ?? [];
  const repo = ctx.repository || "the repository";
  if (api?.status === 409)
    return {
      check: "changed",
      title: "The manifest changed since the check",
      description: `Someone pushed to ${repo}'s .pkey/ after you checked it. Check again to see what the link will do now.`,
      problems: [],
    };
  switch (api?.reason) {
    case "repository":
      return {
        check: "repository",
        title: "That isn't a GitHub repository",
        description: "Use owner/repo or the repository's GitHub URL.",
        problems: [],
      };
    case "app":
      return {
        check: "app",
        title: `The Polaris Key GitHub App can't read ${repo}`,
        description:
          "Install the Polaris Key GitHub App on the repository, then check again.",
        problems: [],
      };
    case "manifest":
      return {
        check: "manifest",
        title: problems.length
          ? `${problems.length} ${problems.length === 1 ? "problem" : "problems"} in .pkey/`
          : "The manifest couldn't be read",
        description: problems.length
          ? "Fix them in one commit, then check again."
          : message || "Check that the repository has a .pkey/ directory.",
        problems,
      };
    case "slug":
      return {
        check: "slug",
        title: `The manifest isn't ${ctx.slug}'s`,
        description: `${message ? `${capitalize(message)}. ` : ""}Set product.slug in .pkey/product to ${ctx.slug}, push, then check again.`,
        problems: [],
      };
    case "policy":
      return {
        check: "policy",
        title: "The manifest can't be applied to this product",
        description: message || "Fix the manifest, then check again.",
        problems,
      };
    case "product":
      return {
        check: "product",
        title: "This product can't be linked here",
        description: message,
        problems: [],
      };
    default: {
      const copy = errorCopy(error);
      return {
        check: "product",
        title: copy.title,
        description: copy.description,
        problems: [],
      };
    }
  }
}

const capitalize = (s: string): string =>
  s ? s[0]!.toUpperCase() + s.slice(1) : s;

const CHECK_TITLE: Record<CheckId, string> = {
  repository: "Repository",
  app: "Polaris Key app installed",
  manifest: "Manifest valid",
  slug: "Manifest slug matches",
  policy: "Applies to this product",
};

function checkState(
  id: CheckId,
  phase: "idle" | "checking" | "passed" | "refused",
  failed: Refusal["check"] | null,
): RowState {
  if (phase === "idle") return "todo";
  if (phase === "checking") return "checking";
  if (phase === "passed") return "done";
  if (failed === "changed" || failed === "product" || failed === null)
    return "todo";
  const at = CHECKS.indexOf(failed);
  const me = CHECKS.indexOf(id);
  return me < at ? "done" : me === at ? "failed" : "todo";
}

function PlanList({
  title,
  items,
  tone = "default",
}: {
  title: string;
  items: ManifestPlanItem[];
  tone?: "default" | "danger";
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h3
        className={
          tone === "danger"
            ? "text-sm font-medium text-danger"
            : "text-sm font-medium text-fg-strong"
        }
      >
        {title}
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
        {items.map((i) => (
          <li key={`${i.area}:${i.id ?? ""}:${i.summary}`}>{i.summary}</li>
        ))}
      </ul>
    </section>
  );
}

export function LinkRepositoryDrawer({
  slug,
  productName,
  open,
  onClose,
  onLinked,
}: {
  slug: string;
  productName: string;
  open: boolean;
  onClose: () => void;
  /** Called with what the link applied, after the drawer closes. */
  onLinked?: (result: LinkExistingResult) => void;
}): React.ReactElement {
  const [repoUrl, setRepoUrl] = React.useState("");
  const [phase, setPhase] = React.useState<
    "idle" | "checking" | "passed" | "refused"
  >("idle");
  const [checked, setChecked] = React.useState<LinkCheckResult | null>(null);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const [linking, setLinking] = React.useState(false);
  const busy = phase === "checking" || linking;

  React.useEffect(() => {
    if (!open) return;
    setRepoUrl("");
    setPhase("idle");
    setChecked(null);
    setRefusal(null);
  }, [open]);

  const check = async (): Promise<void> => {
    const url = repoUrl.trim();
    if (!url || busy) return;
    setPhase("checking");
    setRefusal(null);
    setChecked(null);
    try {
      const res = await mutate("checkRepoLink", slug, url);
      setChecked(res);
      setPhase("passed");
    } catch (err) {
      setRefusal(linkRefusal(err, { slug, repository: url }));
      setPhase("refused");
    }
  };

  const link = async (): Promise<void> => {
    if (!checked || busy) return;
    setLinking(true);
    try {
      const res = await mutate(
        "linkProductRepo",
        slug,
        repoUrl.trim(),
        checked.manifestDigest,
      );
      toast.success(`Linked to ${res.repository}`);
      onClose();
      onLinked?.(res);
    } catch (err) {
      setRefusal(linkRefusal(err, { slug, repository: checked.repository }));
      setChecked(null);
      setPhase("refused");
    } finally {
      setLinking(false);
    }
  };

  const plan = checked?.plan ?? null;
  const blocked = (plan?.conflicts.length ?? 0) > 0;
  const removes = plan?.delete.length ?? 0;
  const failed = refusal?.check ?? null;

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      dismissible={!busy}
      size="lg"
      title="Link repository"
      description={`Hands ${productName} over to its repository's .pkey/ manifest. After the link, every push to the default branch re-applies it.`}
    >
      <form
        noValidate
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void (checked && !blocked ? link() : check());
        }}
      >
        <DrawerBody className="space-y-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <FormField
              className="min-w-0 flex-1"
              name="repoUrl"
              label="Repository"
              required
              help="owner/repo or its GitHub URL. The repository's .pkey/product must name this product's slug."
              value={repoUrl}
              onChange={(v: string) => {
                setRepoUrl(v);
                // A check describes one repository: editing it starts over.
                if (phase !== "idle" && phase !== "checking") {
                  setPhase("idle");
                  setChecked(null);
                  setRefusal(null);
                }
              }}
            >
              {(f) => (
                <Input
                  {...f}
                  mono
                  autoComplete="off"
                  placeholder="acme/tonebox"
                  disabled={busy}
                />
              )}
            </FormField>
            <Button
              type="button"
              variant="outline"
              // Level with the input: the field's label sits above it.
              className="sm:mt-6"
              loading={phase === "checking"}
              disabled={!repoUrl.trim() || linking}
              onClick={() => void check()}
            >
              {phase === "refused" ? "Check again" : "Check"}
            </Button>
          </div>

          <ul
            aria-label="Link checks"
            className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-page"
          >
            {CHECKS.map((id) => {
              const state = checkState(id, phase, failed);
              const detail =
                state === "failed" && refusal
                  ? refusal.title
                  : id === "repository" && state === "done"
                    ? (checked?.repository ?? repoUrl.trim())
                    : id === "slug"
                      ? `.pkey/product names ${slug}`
                      : id === "policy"
                        ? "Nothing in it is refused for this product"
                        : id === "app"
                          ? "Reads the repository's .pkey/ and releases"
                          : id === "manifest"
                            ? ".pkey/schema, product and release parse"
                            : "owner/repo";
              return (
                <CheckRow
                  key={id}
                  state={state}
                  title={CHECK_TITLE[id]}
                  detail={detail}
                />
              );
            })}
          </ul>

          {refusal ? (
            <Callout tone="danger" title={refusal.title} live>
              <p>{refusal.description}</p>
              {refusal.problems.length ? (
                <ul className="mt-2 list-disc space-y-0.5 pl-5">
                  {refusal.problems.map((p) => (
                    <li key={p} className="font-mono text-xs">
                      {p}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : null}

          {plan ? (
            <div
              className="space-y-4 rounded-lg border border-border bg-surface-raised p-4"
              aria-live="polite"
            >
              <p className="text-sm text-fg-muted">
                Linking {productName} to{" "}
                <span className="font-mono text-fg">{checked?.repository}</span>{" "}
                applies its manifest now:
              </p>
              <PlanList
                title="Blocks the link"
                items={plan.conflicts}
                tone="danger"
              />
              <PlanList title="Applies" items={plan.apply} />
              <PlanList
                title="Stays (set in the console)"
                items={plan.skipClaimed}
              />
              <PlanList title="Removes" items={plan.delete} />
              {checked?.remainingSecrets.length ? (
                <p className="text-sm text-fg-muted">
                  Then set{" "}
                  {checked.remainingSecrets.map((n, i) => (
                    <React.Fragment key={n}>
                      {i > 0 ? ", " : ""}
                      <span className="font-mono text-fg">{n}</span>
                    </React.Fragment>
                  ))}{" "}
                  in Keys &amp; secrets: the manifest names{" "}
                  {checked.remainingSecrets.length === 1 ? "it" : "them"} but
                  doesn't carry the values.
                </p>
              ) : null}
            </div>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            // Removing rows is the destructive half of a link: say so on the button.
            variant={removes > 0 ? "danger" : undefined}
            iconStart={<GitBranch aria-hidden />}
            loading={linking}
            disabled={!checked || blocked || phase !== "passed"}
            disabledReason={
              blocked
                ? "Resolve what blocks the link first."
                : !checked
                  ? "Check the repository first."
                  : undefined
            }
          >
            {removes > 0 ? `Link and remove ${removes}` : "Link repository"}
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}
