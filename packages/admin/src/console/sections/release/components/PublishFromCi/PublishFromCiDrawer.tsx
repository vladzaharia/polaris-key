/**
 * Publish from CI (A-32.11, FLOWS W9): the drawer that says what stands between the product's
 * repository and a tag that publishes. "Polaris Key does this" rows from the readiness read; the
 * release environment and the tag ruleset are one click each when the App may write them.
 * A refusal names the permission and sends the owner to GitHub to grant it.
 * The two steps for you (the setup pull request and the first tag) are A-32.12's.
 */

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { HttpError, type CiFixCheck } from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { Drawer, DrawerBody } from "../../../../../ui/Drawer.js";
import { ErrorState } from "../../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../../ui/Skeleton.js";
import { AutoList, type AutoItem } from "../../../../../ui/wizard/index.js";
import { mutate } from "../../../../data/mutations.js";
import { Link } from "../../../../router.js";
import { r } from "../../../../routes.js";
import { PublisherDrawer } from "../../../core/pages/KeysCi.js";
import { useCiPublisher } from "../../../core/pages/ciData.js";
import { useCiReadiness } from "../../data.js";
import { REVIEW_PERMISSIONS_URL, ciRows, type CiRow } from "./rows.js";

/** The permission a refusal named, if it was the permission refusal. */
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
  const [pending, setPending] = React.useState<ReadonlySet<CiFixCheck>>(
    new Set(),
  );
  const [refused, setRefused] = React.useState<ReadonlyMap<CiFixCheck, string>>(
    new Map(),
  );
  const [failed, setFailed] = React.useState<ReadonlySet<CiFixCheck>>(
    new Set(),
  );
  const [granting, setGranting] = React.useState(false);

  const fix = async (id: CiFixCheck): Promise<void> => {
    setPending((s) => new Set(s).add(id));
    setFailed((s) => without(s, id));
    setRefused((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    try {
      await mutate("fixCiReadiness", slug, [id]);
    } catch (err) {
      const permission = refusedPermission(err);
      if (permission === undefined) setFailed((s) => new Set(s).add(id));
      else
        setRefused((m) =>
          new Map(m).set(id, permission ?? "GitHub App installed"),
        );
    } finally {
      setPending((s) => without(s, id));
    }
  };

  const rows = readiness.data
    ? ciRows(readiness.data, { pending, refused, failed })
    : [];

  const action = (row: CiRow): React.ReactNode => {
    switch (row.fix) {
      case "create":
        return (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void fix(row.id as CiFixCheck)}
          >
            {row.fixLabel}
          </Button>
        );
      case "edit":
        return (
          <Button size="sm" variant="outline" onClick={() => setGranting(true)}>
            {row.fixLabel}
          </Button>
        );
      case "keys":
        return (
          <Button asChild size="sm" variant="outline">
            <Link to={r.keys(slug)}>{row.fixLabel}</Link>
          </Button>
        );
      case "install":
        return external(row.fixLabel ?? "Install on GitHub");
      case "permissions":
        return external("Review permissions on GitHub");
      default:
        return null;
    }
  };

  const items: AutoItem[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    state: row.state,
    status: row.status,
    result: row.result,
    action: action(row),
  }));
  // A done publisher row keeps "Change" (its action shows on done rows only through the list's
  // own rule, so it is rendered as the row's result link instead).
  const withChange = items.map((it, i) =>
    rows[i]?.fix === "keys" && it.state === "done"
      ? { ...it, result: <ChangeLink slug={slug} detail={rows[i]?.result} /> }
      : it,
  );

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
        size="md"
      >
        <DrawerBody className="space-y-4">
          {readiness.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : readiness.isError ? (
            <ErrorState
              error={readiness.error}
              onRetry={() => void readiness.refetch()}
            />
          ) : (
            <AutoList items={withChange} title="Polaris Key checks" />
          )}
        </DrawerBody>
      </Drawer>
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
  slug,
  detail,
}: {
  slug: string;
  detail?: string;
}): React.ReactElement {
  return (
    <>
      {detail ? <span className="font-mono">{detail}</span> : null}
      {detail ? " · " : null}
      <Link to={r.keys(slug)} className="text-accent-fg hover:underline">
        Change in Keys
      </Link>
    </>
  );
}

function external(label: string): React.ReactElement {
  return (
    <Button
      asChild
      size="sm"
      variant="outline"
      iconEnd={<ExternalLink aria-hidden />}
    >
      <a href={REVIEW_PERMISSIONS_URL} target="_blank" rel="noreferrer">
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
