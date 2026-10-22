/**
 * Packages with the feeds off (F-34.8, mockup `packages.feeds-off`): one solid card that says what
 * is refused, who turned the feeds off and when, and that nothing was deleted, with Turn on and
 * the feeds listed under it. A state, not a first-run invitation.
 *
 * Turn on sends the owner row's `version` (`GET …/package-feeds`), never the generic settings
 * counter. A `version_conflict` 409 carries the switch as it stands: the product is refetched so
 * the console shows the truth, and the page either flips (already on) or says so and lets the user
 * try again with the fresh counter.
 */

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CirclePause, KeyRound } from "lucide-react";
import { api } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { formatCount } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { CopyDetails } from "../../../../ui/CopyDetails.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { navigate } from "../../../router.js";
import { SwitchReadError } from "./SwitchReadError.js";
import { useFeedsOverview } from "../data.js";
import {
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  markAfterWrite,
  takeAfterWrite,
  offWhen,
  packageFeedsConflict,
  tokensHref,
} from "../model/model.js";

export function PackageFeedsOff({
  slug,
  name,
}: {
  slug: string;
  name: string;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const gate = useWriteGate("ship", slug);
  const sw = useQuery({
    queryKey: qk.packageFeedsSwitch(slug),
    queryFn: () => api.packageFeeds(slug),
  });
  const overview = useFeedsOverview({ kind: "product", slug });
  const product = useProduct(slug);
  // Only feeds that were set up: what the registry refuses now and keeps for later.
  const feeds = (overview.data?.feeds ?? []).filter((f) => f.configured);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<{
    title: string;
    description?: string;
    action?: string;
    details?: Record<string, unknown>;
  } | null>(null);
  // The owner row's counter, never the generic settings one; a 409 hands back the fresh row.
  const version = React.useRef(0);
  version.current = sw.data?.packageFeeds.version ?? 0;
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (!takeAfterWrite("off-card", slug)) return;
    // After the dialog has handed focus back to its (now gone) opener.
    const id = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [slug]);
  const settle = (): void => {
    void queryClient.invalidateQueries({
      queryKey: qk.product(slug),
      exact: true,
    });
  };
  const turnOn = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await mutate("savePackageFeeds", slug, {
        enabled: true,
        expectedVersion: version.current,
      });
      queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
        packageFeeds: result.packageFeeds,
      });
      markAfterWrite("page", slug);
      toast.success("Package feeds turned on");
    } catch (e) {
      const current = packageFeedsConflict(e);
      if (current) {
        queryClient.setQueryData(qk.packageFeedsSwitch(slug), {
          packageFeeds: current,
        });
        settle();
        if (current.enabled) {
          markAfterWrite("page", slug);
          toast.info("Package feeds were already turned on");
        } else
          setFailure({
            title: "Package feeds changed since you opened this",
            description: "They are still off. Turn them on to continue.",
          });
      } else {
        setFailure(
          errorCopy(e, { area: "distribution", thing: "Package feeds" }),
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const meta = offWhen(
    product.data?.packages?.offBy,
    product.data?.packages?.offAt ?? sw.data?.packageFeeds.updatedAt ?? null,
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title="Packages"
        secondaryActions={[
          {
            label: "Registry tokens",
            icon: <KeyRound aria-hidden />,
            onSelect: () => navigate(tokensHref({ kind: "product", slug })),
          },
        ]}
      />
      <section
        aria-labelledby="feeds-off-title"
        data-feeds-off=""
        className="rounded-xl border border-border bg-surface-raised"
      >
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
          <CirclePause aria-hidden className="size-6 shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1 space-y-1">
            <h2
              id="feeds-off-title"
              ref={heading}
              tabIndex={-1}
              className="m-0 text-base font-semibold text-fg-strong outline-hidden forced-colors:outline-none"
            >
              Package feeds are off for {name}
            </h2>
            <p className="m-0 text-sm">
              Installs and CI publishes are refused.
            </p>
            <p className="m-0 text-xs text-fg-muted">
              {meta ? `${meta} · ` : ""}Nothing was deleted.
            </p>
          </div>
          <Button
            onClick={() => void turnOn()}
            loading={busy}
            disabledReason={
              gate.allowed
                ? sw.data
                  ? undefined
                  : sw.isError
                    ? "Try again first"
                    : "Loading"
                : gate.disabledReason
            }
          >
            Turn on package feeds
          </Button>
        </div>
        {sw.isError ? (
          <div className="mx-5 mb-5">
            <SwitchReadError
              error={sw.error}
              onRetry={() => void sw.refetch()}
            />
          </div>
        ) : null}
        {failure ? (
          <div
            role="alert"
            className="mx-5 mb-5 flex gap-2 rounded-md border border-danger-border bg-danger-subtle p-3 text-sm"
          >
            <CircleAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-danger"
            />
            <div className="space-y-0.5">
              <p className="m-0 font-semibold text-fg-strong">
                {failure.title}
              </p>
              {failure.description ? (
                <p className="m-0 text-fg">{failure.description}</p>
              ) : null}
              <CopyDetails copy={failure} />
            </div>
          </div>
        ) : null}
        {feeds.length ? (
          <ul
            aria-label="Feeds"
            className="m-0 list-none divide-y divide-border border-t border-border p-0 text-fg-muted"
          >
            {feeds.map((f) => {
              const Icon = ECOSYSTEM_ICONS[f.ecosystem];
              const url = f.baseUrl?.replace(/^https?:\/\//, "");
              return (
                <li
                  key={f.ecosystem}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
                >
                  <Icon aria-hidden className="size-4 shrink-0" />
                  <span className="font-medium text-fg">
                    {ECOSYSTEM_LABELS[f.ecosystem]}
                  </span>
                  {url ? (
                    <span className="break-all font-mono text-xs">{url}</span>
                  ) : null}
                  <span className="ms-auto text-xs">
                    {f.packages
                      ? `${formatCount(f.packages)} ${f.packages === 1 ? "package" : "packages"}`
                      : "no packages yet"}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
