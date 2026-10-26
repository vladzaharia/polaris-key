/**
 * Publish from CI (A-32.11, FLOWS W9): the drawer that says what stands between the product's
 * repository and a tag that publishes. "Polaris Key does this" rows from the readiness read; the
 * release environment and the tag ruleset are one click each when the App may write them.
 * A refusal names the permission and sends the owner to GitHub to grant it.
 * Below them, the two steps for you (A-32.12): the setup pull request or one command, then a
 * tag, and Done.
 */

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { HttpError, type CiFixCheck } from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { Drawer, DrawerBody } from "../../../../../ui/Drawer.js";
import { ErrorState } from "../../../../../ui/ErrorState.js";
import { announce, LiveRegion } from "../../../../../ui/LiveRegion.js";
import { Skeleton } from "../../../../../ui/Skeleton.js";
import {
  StepUpNotice,
  useStepUpDraft,
} from "../../../../../ui/useStepUpDraft.js";
import type { AutoItem } from "../../../../../ui/wizard/index.js";
import {
  askReason,
  useAccessAdmins,
  useCan,
} from "../../../../access/useCan.js";
import { mutate } from "../../../../data/mutations.js";
import { Link, useLocation } from "../../../../router.js";
import { r } from "../../../../routes.js";
import {
  IssueCiTokenFlow,
  PublisherDrawer,
} from "../../../core/pages/KeysCi.js";
import { useCiPublisher } from "../../../core/pages/ciData.js";
import { useCiReadiness, useSetupPullRequest } from "../../data.js";
import { CiChecks } from "./CiChecks.js";
import { PublishSteps } from "./PublishSteps.js";
import {
  LABELS_BY_FIX,
  REVIEW_PERMISSIONS_URL,
  ciRows,
  type CiRow,
} from "./rows.js";

/** The permission a refusal named, if it was the permission refusal; `null` for no App at all. */
function refusedPermission(err: unknown): string | null | undefined {
  if (!(err instanceof HttpError) || err.status !== 409) return undefined;
  if (err.reason === "app_not_installed") return null;
  if (err.reason !== "app_permission") return undefined;
  const body = err.body as { permission?: unknown } | undefined;
  return typeof body?.permission === "string"
    ? body.permission
    : "administration: write";
}

export function PublishFromCiDrawer({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const readiness = useCiReadiness(slug);
  const publisher = useCiPublisher(slug);
  const prState = useSetupPullRequest(slug);
  const canEdit = useCan("ship", slug, "edit");
  const admins = useAccessAdmins("ship", slug, open && !canEdit);
  const noEdit = canEdit
    ? undefined
    : askReason("ship", admins.data?.admins, true);
  const [pending, setPending] = React.useState<ReadonlySet<CiFixCheck>>(
    new Set(),
  );
  const [refused, setRefused] = React.useState<ReadonlyMap<CiFixCheck, string>>(
    new Map(),
  );
  const [failed, setFailed] = React.useState<ReadonlySet<CiFixCheck>>(
    new Set(),
  );
  const [denied, setDenied] = React.useState(false);
  const [granting, setGranting] = React.useState(false);
  const [otherCi, setOtherCi] = React.useState(false);
  const body = React.useRef<HTMLDivElement>(null);
  const hash = useLocation().hash;
  const onKeys = hash.split("?")[0] === r.keys(slug).split("?")[0];
  const stepUp = useStepUpDraft(`publish-ci:${slug}`, open, () =>
    onOpenChange(true),
  );
  const [stepUpFor, setStepUpFor] = React.useState<CiFixCheck | null>(null);

  // A refusal is about the moment it came in: a new open, or a changed read, starts clean.
  React.useEffect(() => {
    if (!open) return;
    setPending(new Set());
    setRefused(new Map());
    setFailed(new Set());
    setDenied(false);
    setStepUpFor(null);
  }, [open]);
  React.useEffect(() => {
    setRefused(new Map());
    setFailed(new Set());
  }, [readiness.data]);

  /** Focus lands on the next thing to do, not on the dialog, once a row turns done. */
  const focusNext = (): void => {
    window.requestAnimationFrame(() => {
      const root = body.current;
      const next =
        root?.querySelector<HTMLElement>(
          '[data-state="will"] button:not([aria-disabled="true"]), [data-state="will"] a, [data-state="needs"] a, [data-state="failed"] button',
        ) ?? root?.querySelector<HTMLElement>("[data-ci-step]");
      next?.focus();
    });
  };

  const fix = async (id: CiFixCheck): Promise<void> => {
    setPending((s) => new Set(s).add(id));
    setFailed((s) => without(s, id));
    setStepUpFor(null);
    setRefused((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    try {
      await mutate("fixCiReadiness", slug, [id]);
      announce(`${LABELS_BY_FIX[id]} created`);
      await readiness.refetch();
      focusNext();
    } catch (err) {
      if (stepUp.check(err)) setStepUpFor(id);
      else if (err instanceof HttpError && err.status === 403) setDenied(true);
      else {
        const permission = refusedPermission(err);
        if (permission === undefined) setFailed((s) => new Set(s).add(id));
        // No App on the repository: the read says so, and the list becomes the install.
        else if (permission === null) void readiness.refetch();
        else setRefused((m) => new Map(m).set(id, permission));
      }
    } finally {
      setPending((s) => without(s, id));
    }
  };

  // Back from the step-up sign-in: the click that was refused runs again.
  const retried = React.useRef(false);
  React.useEffect(() => {
    if (!open || retried.current) return;
    const saved = stepUp.take();
    if (!saved) return;
    retried.current = true;
    const id = saved.check;
    if (id === "environment" || id === "ruleset") void fix(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const links = readiness.data?.links;
  const rows = readiness.data
    ? ciRows(readiness.data, {
        pending,
        refused,
        failed,
        pullRequest: prState.data?.pullRequest?.number ?? null,
      })
    : [];

  const recheck = (): void => {
    setRefused(new Map());
    setFailed(new Set());
    void readiness.refetch();
  };

  const action = (row: CiRow): React.ReactNode => {
    switch (row.fix) {
      case "create":
        return (
          <Button
            size="sm"
            variant="outline"
            loading={row.busy}
            disabledReason={noEdit}
            onClick={() => void fix(row.id as CiFixCheck)}
          >
            {row.fixLabel}
          </Button>
        );
      case "edit":
        return (
          <Button
            size="sm"
            variant="outline"
            disabledReason={noEdit}
            onClick={() => setGranting(true)}
          >
            {row.fixLabel}
          </Button>
        );
      case "recheck":
        return (
          <Button size="sm" variant="outline" onClick={recheck}>
            {row.fixLabel}
          </Button>
        );
      case "install":
        return external(
          row.fixLabel ?? "Install the GitHub App",
          links?.install ?? REVIEW_PERMISSIONS_URL,
          "primary",
        );
      case "permissions":
        return (
          <span className="flex flex-wrap items-center gap-2">
            {external(
              "Review permissions on GitHub",
              links?.installation ?? REVIEW_PERMISSIONS_URL,
            )}
            {row.recheck ? (
              <Button size="sm" variant="ghost" onClick={recheck}>
                Check again
              </Button>
            ) : null}
          </span>
        );
      default:
        return null;
    }
  };

  const items: AutoItem[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    state: row.state,
    status: row.status,
    result:
      row.fix === "keys" && row.state === "done" ? (
        <ChangeLink
          detail={row.result}
          to={r.keys(slug)}
          onHere={onKeys ? () => setGranting(true) : undefined}
        />
      ) : (
        row.result
      ),
    action: action(row),
  }));
  const appMissing = rows.length === 1 && rows[0]?.id === "app";

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        title="Publish from CI"
        description={
          readiness.data?.repository
            ? `Tags pushed to ${readiness.data.repository} publish releases.`
            : "Tags pushed to the linked repository publish releases."
        }
        size="lg"
      >
        <DrawerBody className="space-y-4">
          <div ref={body} className="space-y-4">
            {readiness.isPending ? (
              <>
                <LiveRegion message="Loading checks" />
                <ul
                  aria-hidden
                  className="divide-y divide-border rounded-lg border border-border"
                >
                  {[0, 1, 2, 3, 4].map((i) => (
                    <li key={i} className="flex min-h-11 items-center px-3">
                      <Skeleton className="h-4 w-2/3 bg-border" />
                    </li>
                  ))}
                </ul>
              </>
            ) : readiness.isError ? (
              <ErrorState
                error={readiness.error}
                onRetry={() => void readiness.refetch()}
              />
            ) : (
              <>
                {noEdit ? (
                  <p className="text-sm text-fg-muted">{noEdit}</p>
                ) : null}
                {denied ? (
                  <p role="alert" className="text-sm text-warning">
                    You need edit access to Ship builds.
                  </p>
                ) : null}
                {stepUp.needed && stepUpFor ? (
                  <div className="space-y-2">
                    <StepUpNotice />
                    <Button
                      size="sm"
                      onClick={() => stepUp.signIn({ check: stepUpFor })}
                    >
                      Sign in again
                    </Button>
                  </div>
                ) : null}
                <CiChecks items={items} />
                {appMissing ? (
                  <div className="space-y-3">
                    <p className="text-sm text-fg-muted">
                      The other checks and your steps follow once the App is
                      installed.
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOtherCi(true)}
                    >
                      Use another CI
                    </Button>
                  </div>
                ) : (
                  <PublishSteps
                    slug={slug}
                    readiness={readiness.data}
                    open={open}
                    canEdit={canEdit}
                    noEditReason={noEdit}
                    onUseOtherCi={() => setOtherCi(true)}
                    onRefetchReadiness={() => void readiness.refetch()}
                  />
                )}
              </>
            )}
          </div>
        </DrawerBody>
      </Drawer>
      <IssueCiTokenFlow slug={slug} open={otherCi} onOpenChange={setOtherCi} />
      <PublisherDrawer
        slug={slug}
        open={granting}
        policy={publisher.data ?? null}
        onClose={() => setGranting(false)}
        onOpen={() => setGranting(true)}
      />
    </>
  );
}

function ChangeLink({
  detail,
  to,
  onHere,
}: {
  detail?: string;
  to: string;
  /** On Keys already: the link opens the publisher edit instead of going nowhere. */
  onHere?: () => void;
}): React.ReactElement {
  return (
    <>
      {detail ? <span className="font-mono">{detail}</span> : null}
      {detail ? " · " : null}
      <Link
        to={to}
        className="text-accent-fg underline underline-offset-2 hover:no-underline"
        onClick={
          onHere
            ? (e) => {
                e.preventDefault();
                onHere();
              }
            : undefined
        }
      >
        Change in Keys
      </Link>
    </>
  );
}

function external(
  label: string,
  href: string,
  variant: "outline" | "primary" = "outline",
): React.ReactElement {
  return (
    <Button
      asChild
      size="sm"
      variant={variant}
      iconEnd={<ExternalLink aria-hidden />}
    >
      <a href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    </Button>
  );
}

function without<T>(s: ReadonlySet<T>, v: T): ReadonlySet<T> {
  const n = new Set(s);
  n.delete(v);
  return n;
}
