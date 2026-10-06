/**
 * One resync flow (FLOWS.md C-10, C-56; UX-78): the one confirm and the one result that every
 * "Resync from repo" in the console uses: Settings → Repository, Releases (header and the Repo
 * sync drawer), License → Enrollment's probes, Identity → Sign-in and the Products row menu.
 *
 * - **The dialog says what will change.** On open it asks the worker for the resync's dry run
 *   (`POST …/release/resync?dryRun=1`, `planRepoManifest`'s plan, S-18 §4.5 item 4) and lists
 *   what applies, what stays because it was set in the console, what goes and what blocks the
 *   resync. Nothing is written until **Resync from repo**. A plan with conflicts keeps the
 *   button disabled: the resync would refuse them anyway.
 * - **The result is a panel, focused and announced** (FLOWS.md C11, C18): what was updated,
 *   what was refused and the pack sets, in words; once the confirm has closed and returned
 *   focus, the panel takes it, scrolls into view and is announced through the shared live
 *   region. A result the page shows gets no toast (EXPERIENCE §7).
 *
 * Callers use `useResyncFlow()` (dialog + panel, one product or a row's) or `ResyncDialog` and
 * `ResyncResultPanel` directly when the result lives elsewhere (the Repo sync drawer).
 */

import * as React from "react";
import {
  ApiError,
  type ManifestPlanItem,
  type ResyncPlanResult,
  type ResyncResult,
} from "../../api.js";
import { confirmFor } from "../../lib/actions.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { formatCount } from "../../lib/format.js";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { announce } from "../../ui/LiveRegion.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { mutate } from "../data/mutations.js";

/** The product a resync is for. */
export interface ResyncTarget {
  slug: string;
  name: string;
}

/** What a finished resync hands back: the product, where it read from, and what it did. */
export interface ResyncOutcome {
  target: ResyncTarget;
  /** `owner/repo` from the dry run, when it answered. */
  repository: string | null;
  result: ResyncResult;
}

/** The words for `ResyncResult.updated`'s section ids (worker `release/resync.ts`). */
const SECTION: Record<string, string> = {
  product: "product details",
  services: "services",
  schema: "catalog",
  tiers: "tiers",
  profiles: "profiles",
  oidc: "sign-in",
  provisioning: "provisioning hooks",
  fingerprint: "device fingerprint policy",
  autoIssue: "auto-issue",
  release: "release settings",
  releases: "releases",
  deliverables: "deliverables",
  publisher: "trusted publisher",
  edgeMint: "edge mint",
  edgeMintApprovals: "edge-mint approvals (re-approve them on Edge mint)",
};

export function sectionLabel(id: string): string {
  return SECTION[id] ?? id;
}

const plural = (n: number, one: string, many: string): string =>
  `${formatCount(n)} ${n === 1 ? one : many}`;

/** Word a dry-run refusal for the check it failed; anything else reads through `errorCopy`. */
export function planRefusal(error: unknown): {
  title: string;
  description: string;
  problems: string[];
} {
  const api = error instanceof ApiError ? error : null;
  const message =
    api?.message && api.message !== `api ${api.status}` ? api.message : "";
  const problems = api?.errors ?? [];
  switch (api?.reason) {
    case "product":
      return {
        title: "This product isn't linked to a repository",
        description:
          message && message !== "product is not linked to a repo"
            ? message
            : "Link a repository in Settings first.",
        problems: [],
      };
    case "app":
      return {
        title: "The Polaris Key GitHub App can't read the repository",
        description:
          "Install the Polaris Key GitHub App on the repository, then check again.",
        problems: [],
      };
    case "manifest":
      return {
        title: problems.length
          ? `${plural(problems.length, "problem", "problems")} in .pkey/`
          : "The manifest couldn't be read",
        description: problems.length
          ? `Fix ${problems.length === 1 ? "it" : "them"} in one commit, then check again.`
          : message || "Check that the repository has a .pkey/ directory.",
        problems,
      };
    case "slug":
      return {
        title: "The manifest names another product",
        description: `${message ? `${message[0]!.toUpperCase()}${message.slice(1)}. ` : ""}Set product.slug in .pkey/product to this product's slug, push, then check again.`,
        problems: [],
      };
    default: {
      const copy = errorCopy(error, { thing: "Product" });
      return {
        title: copy.title,
        description: copy.description ?? "",
        problems: [],
      };
    }
  }
}

/** One group of the plan: a heading and its lines. Empty groups render nothing. */
export function PlanList({
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
            ? "text-sm font-bold text-danger"
            : "text-sm font-bold text-fg-strong"
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

type PlanState =
  | { status: "loading" }
  | { status: "ready"; data: ResyncPlanResult }
  | { status: "refused"; error: unknown };

/** The confirm: the dry run's plan, then the resync. */
export function ResyncDialog({
  target,
  open,
  onOpenChange,
  onResult,
}: {
  target: ResyncTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with what the resync did, before the dialog closes. */
  onResult?: (outcome: ResyncOutcome) => void;
}): React.ReactElement {
  const policy = confirmFor("repo.resync");
  const [plan, setPlan] = React.useState<PlanState>({ status: "loading" });
  const run = React.useRef(0);
  const slug = target?.slug ?? "";
  const name = target?.name || slug;

  const check = React.useCallback(async (): Promise<void> => {
    if (!slug) return;
    const mine = ++run.current;
    setPlan({ status: "loading" });
    try {
      const data = await mutate("planResync", slug);
      // A body without a plan is a worker that predates the dry run: say so, never crash.
      if (!data?.plan) throw new Error("The resync plan couldn't be read.");
      if (run.current === mine) setPlan({ status: "ready", data });
    } catch (error) {
      if (run.current === mine) setPlan({ status: "refused", error });
    }
  }, [slug]);

  // A fresh plan every time it opens: the repository may have moved since the last one.
  React.useEffect(() => {
    if (open && slug) void check();
    if (!open) run.current++;
  }, [open, slug, check]);

  const ready = plan.status === "ready" ? plan.data : null;
  const conflicts = ready?.plan.conflicts.length ?? 0;
  const empty =
    ready !== null &&
    ready.plan.apply.length +
      ready.plan.skipClaimed.length +
      ready.plan.delete.length +
      conflicts ===
      0;
  const refusal = plan.status === "refused" ? planRefusal(plan.error) : null;

  return (
    <ConfirmDialog
      open={open && target !== null}
      onOpenChange={onOpenChange}
      intent={policy.intent === "none" ? "caution" : policy.intent}
      title={`Resync ${name} from its repository?`}
      description={
        ready ? (
          <>
            Polaris Key reads <span className="font-mono">.pkey/</span> from{" "}
            <span className="font-mono text-fg">{ready.repository}</span> at{" "}
            <span className="font-mono text-fg">
              {ready.commit.slice(0, 7)}
            </span>{" "}
            and applies it now.
          </>
        ) : (
          "Polaris Key reads .pkey/ from the repository's default branch and applies it now."
        )
      }
      consequences={[
        "A part the manifest gets wrong is refused and listed; the rest still applies.",
        "Clients see the change on their next document fetch.",
      ]}
      confirmLabel="Resync from repo"
      confirmDisabled={plan.status !== "ready" || conflicts > 0}
      describeError={(e) => errorCopy(e, { thing: "Product" })}
      onConfirm={async () => {
        if (!target) return;
        const result = await mutate("resyncProduct", target.slug);
        onResult?.({
          target: { slug: target.slug, name },
          repository: ready?.repository ?? null,
          result,
        });
      }}
    >
      <div
        className="space-y-4 rounded-lg border border-border bg-surface-raised p-4"
        aria-live="polite"
        aria-busy={plan.status === "loading"}
        data-testid="resync-plan"
      >
        {plan.status === "loading" ? (
          <>
            <p className="text-sm text-fg-muted">
              Reading the repository's manifest…
            </p>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </>
        ) : refusal ? (
          <Callout
            tone="danger"
            title={refusal.title}
            action={
              <Button variant="outline" size="sm" onClick={() => void check()}>
                Check again
              </Button>
            }
          >
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
        ) : ready && empty ? (
          <p className="text-sm text-fg">
            Nothing to change: {name} already matches its manifest.
          </p>
        ) : ready ? (
          <>
            <PlanList
              title="Blocks the resync"
              items={ready.plan.conflicts}
              tone="danger"
            />
            {conflicts ? (
              <p className="text-sm text-fg-muted">
                Fix {conflicts === 1 ? "it" : "them"} in .pkey/ and push, then
                check again.
              </p>
            ) : null}
            <PlanList title="Applies" items={ready.plan.apply} />
            <PlanList
              title="Stays (set in the console)"
              items={ready.plan.skipClaimed}
            />
            <PlanList title="Removes" items={ready.plan.delete} />
            {conflicts ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void check()}
                >
                  Check again
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/** Is a dialog other than the one holding `el` still open (the confirm closing, a menu)? */
function otherDialogOpen(el: HTMLElement): boolean {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="alertdialog"], [role="dialog"]',
    ),
  ].some((d) => !d.contains(el));
}

/** The panel's title: a verified fact, the product's name first. */
export function resultTitle(
  result: ResyncResult,
  productName?: string,
  repository?: string | null,
): string {
  const refused = result.refused?.length ?? 0;
  const who = productName ? ` ${productName}` : "";
  if (refused)
    return `Resynced${who}, with ${plural(refused, "part", "parts")} refused`;
  return repository
    ? `Resynced${who} from ${repository}`
    : `Resynced${who} from its repository`;
}

/**
 * What a resync did (RSY-3): updated sections, refused parts, pack sets. It takes focus once the
 * dialog that produced it has closed, scrolls into view, and announces its title.
 */
export function ResyncResultPanel({
  result,
  productName,
  repository,
  title,
  onDismiss,
}: {
  result: ResyncResult;
  productName?: string;
  repository?: string | null;
  /** Overrides the title (Link repository: "Linked to acme/tonebox"). */
  title?: string;
  onDismiss: () => void;
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const updated = result.updated ?? [];
  const refused = result.refused ?? [];
  const packs = result.packSets;
  const heading = title ?? resultTitle(result, productName, repository);

  // Focus and announce once per result, after the confirm has closed and Radix has returned
  // focus to its opener (it does so on a timer after unmount): wait for every other dialog to
  // go, then take focus a frame later.
  React.useEffect(() => {
    let raf = 0;
    let frames = 0;
    const settle = (): void => {
      const el = ref.current;
      if (!el) return;
      if (otherDialogOpen(el) && frames < 120) {
        frames++;
        raf = requestAnimationFrame(settle);
        return;
      }
      raf = requestAnimationFrame(() => {
        el.focus({ preventScroll: true });
        el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      });
    };
    raf = requestAnimationFrame(settle);
    announce(heading);
    return () => cancelAnimationFrame(raf);
    // Once per result object: a re-render with the same result must not steal focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-testid="resync-result"
      aria-label={heading}
      className="rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-focus"
    >
      <Callout
        tone={refused.length || (packs && !packs.ok) ? "warning" : "success"}
        title={heading}
        action={
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        }
      >
        <div className="space-y-2">
          <p>
            {updated.length
              ? `Updated: ${updated.map(sectionLabel).join(", ")}.`
              : `Nothing changed: ${productName ?? "the product"} already matched its manifest.`}
          </p>
          {refused.length ? (
            <ul className="list-disc space-y-1 pl-5" aria-label="Refused">
              {refused.map((x) => (
                <li key={`${x.code}:${x.path}`}>
                  <span className="font-mono text-xs">{x.path}</span>:{" "}
                  {x.message}
                </li>
              ))}
            </ul>
          ) : null}
          {packs ? (
            <p>
              {packs.ok
                ? `Pack sets resolved: ${formatCount(packs.sets)}.`
                : `Pack sets were cleared: ${packs.message}`}
            </p>
          ) : null}
        </div>
      </Callout>
    </div>
  );
}

/**
 * The dialog and the panel together, for a page that resyncs one product (or a row's): `start`
 * opens the confirm for a target; `panel` is the last result, or `null`.
 */
export function useResyncFlow(): {
  start: (target: ResyncTarget) => void;
  dialog: React.ReactElement;
  panel: React.ReactElement | null;
  outcome: ResyncOutcome | null;
} {
  const [target, setTarget] = React.useState<ResyncTarget | null>(null);
  const [open, setOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<ResyncOutcome | null>(null);
  const start = React.useCallback((t: ResyncTarget) => {
    setTarget(t);
    setOpen(true);
  }, []);
  const dialog = (
    <ResyncDialog
      target={target}
      open={open}
      onOpenChange={setOpen}
      onResult={setOutcome}
    />
  );
  const panel = outcome ? (
    <ResyncResultPanel
      result={outcome.result}
      productName={outcome.target.name}
      repository={outcome.repository}
      onDismiss={() => setOutcome(null)}
    />
  ) : null;
  return { start, dialog, panel, outcome };
}
