/**
 * One step of a store's plan (A-18j; notes/S-15 §8.1 step 6), rendered from what the server's
 * plan says about it, never from the store's name:
 *
 * - **API** steps run their request through `StepDialog` (plain, or typed for submit, release
 *   and price), or hand off to the console page that owns them.
 * - **Link** steps show a copy card with the values from the listing model, the store's page,
 *   and a live verifier: while the page is open the step's check runs every `every` seconds for
 *   up to `until` seconds (10 s for 15 minutes), with **Check now**; an operator-asserted step
 *   offers **Mark as done** instead. A pending check survives a closed tab as a ledger row.
 * - **CI** steps wait for the next publish run and show the publish action's command line.
 * - **PR** steps name the repository CI opens the pull request against.
 *
 * What a step shows afterwards is the store's re-read (the plan refetches), never the request,
 * plus what the run left for the operator in the store's own console (`FollowUpNote`: the older
 * Play images, counted and linked, decision 6). There is no delete control anywhere (owner rule).
 */

import * as React from "react";
import { Check, ExternalLink, RefreshCw } from "lucide-react";
import type {
  StorefrontDto,
  StorefrontFollowUp,
  StorefrontStepDto,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { CapabilityBadge } from "../../../../ui/CapabilityBadge.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { toast } from "../../../../ui/toast.js";
import { fromSeconds } from "../../../../lib/format.js";
import { mutate } from "../../../data/mutations.js";
import { Link } from "../../../router.js";
import { productPage } from "../../../routes.js";
import type { ProductPageId } from "../../../nav.js";
import type { StepIntent } from "./StepDialog.js";
import { FollowUpNote } from "./FollowUpNote.js";

/** The key a run's follow-up is kept under (`StepIntent.stepKey`). */
export const stepKeyOf = (store: string, step: string): string =>
  `${store}/${step}`;

/** How a step's state reads. Only a failure is a pill: pills mean attention. */
function StepState({
  step,
}: {
  step: StorefrontStepDto;
}): React.ReactElement | null {
  if (step.state === "failed")
    return (
      <StatusPill tone="danger" size="sm">
        Failed
      </StatusPill>
    );
  if (step.state === "ambiguous")
    return (
      <StatusPill tone="warning" size="sm">
        Outcome unknown
      </StatusPill>
    );
  if (step.state === "done")
    return (
      <span className="inline-flex items-center gap-1 text-sm text-success">
        <Check aria-hidden className="size-4" />
        Done
        {step.stateAt ? (
          <span className="text-fg-muted">
            {" "}
            <Timestamp at={fromSeconds(step.stateAt)} format="relative" />
          </span>
        ) : null}
      </span>
    );
  if (step.state === "pending")
    return <span className="text-sm text-fg-muted">Waiting for the store</span>;
  return null;
}

/** The live verifier of a deep-linked step (S-15 §6.5). */
function useVerifier(
  slug: string,
  store: string,
  step: StorefrontStepDto,
  active: boolean,
): {
  checking: boolean;
  checkNow: () => Promise<void>;
  lastDetail: string | null;
} {
  const [checking, setChecking] = React.useState(false);
  const [lastDetail, setLastDetail] = React.useState<string | null>(null);
  const check = React.useCallback(
    async (poll: boolean) => {
      setChecking(true);
      try {
        const r = await mutate("storefrontCheck", slug, store, step.id, {
          poll,
        });
        setLastDetail(r.detail ?? null);
        return r.satisfied;
      } finally {
        setChecking(false);
      }
    },
    [slug, store, step.id],
  );
  const every = step.link?.every ?? null;
  const until = step.link?.until ?? null;
  React.useEffect(() => {
    if (!active || every === null || until === null) return;
    const started = Date.now();
    let stopped = false;
    const id = window.setInterval(() => {
      if (stopped) return;
      if (Date.now() - started > until * 1000) {
        window.clearInterval(id);
        return;
      }
      void check(true)
        .then((ok) => {
          if (ok) {
            stopped = true;
            window.clearInterval(id);
          }
        })
        .catch(() => {
          // A refused check (a missing connection, the store down) stops the polling; Check now
          // shows the reason.
          stopped = true;
          window.clearInterval(id);
        });
    }, every * 1000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [active, every, until, check]);
  return {
    checking,
    lastDetail,
    checkNow: async () => {
      try {
        const ok = await check(false);
        toast.success(ok ? `${step.label}: done` : `${step.label}: not yet`);
      } catch (e) {
        toast.error(e);
      }
    },
  };
}

export function StepCard({
  slug,
  store,
  step,
  readOnly,
  onIntent,
  followUp = null,
}: {
  slug: string;
  store: StorefrontDto;
  step: StorefrontStepDto;
  readOnly: boolean;
  onIntent: (intent: StepIntent) => void;
  /** What this step's last run left to finish in the store's console. */
  followUp?: StorefrontFollowUp | null;
}): React.ReactElement {
  const open = step.state !== "done";
  const verifying =
    step.mode === "deep-link" &&
    step.link?.verify === "read" &&
    open &&
    !readOnly &&
    !step.blockedBy;
  const verifier = useVerifier(slug, store.id, step, verifying);
  const blocked = readOnly || step.blockedBy !== null;

  const actions: React.ReactNode[] = [];
  if (step.run && open)
    actions.push(
      <Button
        key="run"
        size="sm"
        variant={step.typed ? "danger" : "primary"}
        disabled={blocked}
        onClick={() =>
          onIntent({
            request: step.run!,
            storeLabel: store.confirmationLabel,
            done: `${step.label}: sent to ${store.label}`,
            stepKey: stepKeyOf(store.id, step.id),
          })
        }
      >
        {step.run.verb}
      </Button>,
    );
  if (step.handoff)
    actions.push(
      <Button key="handoff" size="sm" variant="outline" asChild>
        <Link to={productPage(slug, step.handoff.page as ProductPageId)}>
          {step.handoff.label}
        </Link>
      </Button>,
    );
  if (step.mode === "deep-link" && step.link?.url)
    actions.push(
      <Button key="open" size="sm" variant="outline" asChild>
        <a href={step.link.url} target="_blank" rel="noreferrer noopener">
          <ExternalLink aria-hidden />
          Open {store.label}
        </a>
      </Button>,
    );
  if (verifying)
    actions.push(
      <Button
        key="check"
        size="sm"
        variant="outline"
        loading={verifier.checking}
        onClick={() => void verifier.checkNow()}
      >
        <RefreshCw aria-hidden />
        Check now
      </Button>,
    );
  if (
    step.mode === "deep-link" &&
    step.link?.verify === "operator-assertion" &&
    open
  )
    actions.push(
      <Button
        key="assert"
        size="sm"
        variant="outline"
        disabled={blocked}
        onClick={() =>
          step.assert
            ? onIntent({
                request: step.assert,
                storeLabel: store.confirmationLabel,
                done: `${step.label}: marked as done`,
              })
            : void mutate("storefrontCheck", slug, store.id, step.id, {
                assert: true,
              })
                .then(() => toast.success(`${step.label}: marked as done`))
                .catch((e: unknown) => toast.error(e))
        }
      >
        Mark as done
      </Button>,
    );
  if (step.next)
    actions.push(
      <Button
        key="next"
        size="sm"
        disabled={readOnly}
        onClick={() =>
          onIntent({
            request: step.next!,
            storeLabel: store.confirmationLabel,
            done: `${step.next!.verb}: done`,
          })
        }
      >
        {step.next.verb}
      </Button>,
    );

  return (
    <li
      className="rounded-md border border-border bg-surface-raised p-4"
      data-step={step.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_16rem] space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold text-fg-strong">
              {step.label}
            </h4>
            <CapabilityBadge support={{ mode: step.mode }} />
          </div>
          {step.detail ? (
            <p className="text-sm text-fg">{step.detail}</p>
          ) : null}
          {verifier.lastDetail && open ? (
            <p className="text-sm text-fg-muted">{verifier.lastDetail}</p>
          ) : null}
          {step.blockedBy ? (
            <p className="text-sm text-fg-muted">{step.blockedBy}</p>
          ) : null}
          {step.mode === "deep-link" && step.link?.missing.length ? (
            <p className="text-sm text-fg-muted">
              The link opens once the product has its{" "}
              {step.link.missing.join(", ")}.
            </p>
          ) : null}
          {verifying ? (
            <p className="text-xs text-fg-muted">
              Checked every {step.link!.every} s while this page is open.
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <StepState step={step} />
          {actions}
        </div>
      </div>
      {step.mode === "deep-link" && step.copy.length && open ? (
        <dl className="mt-3 divide-y divide-border rounded-md border border-border">
          {step.copy.map((c) => (
            <div
              key={c.label}
              className="flex min-h-10 items-center justify-between gap-3 px-3 py-1.5"
            >
              <dt className="text-sm text-fg-muted">{c.label}</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-xs text-fg">
                  {c.value}
                </span>
                <CopyButton
                  value={c.value}
                  label={`Copy ${c.label}`}
                  size="xs"
                />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {followUp ? (
        <FollowUpNote followUp={followUp} storeLabel={store.label} />
      ) : null}
      {step.ci ? (
        <div className="mt-3 space-y-1 text-sm">
          <p className="text-fg-muted">
            Waiting for the next publish run. The release workflow runs:
          </p>
          <ul className="space-y-1">
            {step.ci.commands.map((cmd) => (
              <li key={cmd} className="font-mono text-xs text-fg">
                {step.ci!.tool} {cmd}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {step.pr ? (
        <p className="mt-3 text-sm text-fg-muted">
          CI opens the pull request against{" "}
          <span className="font-mono text-xs text-fg">{step.pr.repo}</span> on
          the next publish run.
        </p>
      ) : null}
    </li>
  );
}
