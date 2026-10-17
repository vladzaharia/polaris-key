/**
 * Core → Integration (ST-41; docs/research/2026-10-07-dx-consolidation/integration.md §3.2): what an
 * app needs to use each enabled feature, the code to put in it, and where the feature was seen
 * working. Reads ST-40's read model; every Verified fact is a successful SDK request, never a
 * checkbox, and "Hide Integration" is the operator's own choice (`core.setup`), never automatic.
 *
 * Feature cards on the left (a Verified feature with nothing left to do folds to one row), "Your
 * app" beside them: install and configuration for the picked SDK, and progress by platform. The
 * SDK picker is a tablist per card; the pick is the hash query's `sdk=`. Snippets use this
 * product's own names, with a visible placeholder where it has none yet.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  SDK_LABELS,
  renderSdkSetup,
  renderUsage,
} from "@polaris-key/manifest/integration";
import { api } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { focusWhenReady } from "../../../shell/palette/focus.js";
import { useSetup } from "../../../wizard/useSetup.js";
import { CreateLicenseDialog } from "../../license/components/CreateLicenseDialog.js";
import {
  FeatureCard,
  VerifiedOn,
} from "../components/IntegrationFeatureCard.js";
import { PlatformMeters } from "../components/PlatformMeters.js";
import { SdkSetupBlocks } from "../components/SdkSetupBlocks.js";
import { SdkTabs } from "../components/SdkTabs.js";
import {
  SDK_DOC_KEYS,
  defaultSdk,
  isSdkId,
  sdkOrder,
  usageContext,
} from "../model/integration.js";
import { SDK_QUICK_START_ID } from "../model/sdkQuickStart.js";
import { useQueryParams } from "../model/urlState.js";

const PARAMS = ["sdk", "feature"] as const;

export function IntegrationPage({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const view = useQuery({
    queryKey: qk.integration(slug),
    queryFn: () => api.integration(slug),
  });
  const data = view.data;
  const services = data?.snippet.services ?? [];
  // The product's own names for the snippets; a missing catalog or release is just placeholders.
  const catalog = useQuery({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
    enabled: services.includes("config"),
    retry: false,
  });
  const deliverables = useQuery({
    queryKey: qk.deliverables(slug),
    queryFn: () => api.deliverables(slug),
    enabled: services.includes("release"),
    retry: false,
  });
  const setup = useSetup(slug);
  const licenseGate = useWriteGate("license", slug);
  const [q, setQ] = useQueryParams(PARAMS);
  const [licenseOpen, setLicenseOpen] = React.useState(false);
  useLoadingAnnouncement("integration", view.isPending);

  const sdk = isSdkId(q.sdk) ? q.sdk : defaultSdk(data);
  const order = sdkOrder(data);
  const pick = (id: string) => setQ({ sdk: id });
  const hidden = setup.choices.integrationHidden !== null;
  const [how, setHow] = React.useState<"command" | "hand">("command");

  // A link that names a feature lands on its card once the shell has moved focus to the h1 and
  // reset the scroll.
  React.useEffect(() => {
    if (!data || !q.feature) return;
    return focusWhenReady(`integration-${q.feature}`);
  }, [data, q.feature]);

  // The foot's Hide and Show swap in place: focus follows the control that replaced the old one.
  const foot = React.useRef<HTMLButtonElement>(null);
  const toggled = React.useRef(false);
  React.useEffect(() => {
    if (toggled.current) foot.current?.focus();
    toggled.current = false;
  }, [hidden]);
  const toggleHidden = async () => {
    toggled.current = true;
    const ok = await setup.setIntegrationHidden(!hidden);
    if (!ok) toggled.current = false;
  };

  if (view.isPending)
    return (
      <div className="space-y-6">
        <PageHeader title="Integration" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (view.isError || !data)
    return (
      <div className="space-y-6">
        <PageHeader title="Integration" />
        <ErrorState error={view.error} onRetry={() => void view.refetch()} />
      </div>
    );

  const total = data.features.length;
  const verified = data.features.filter((f) => f.status === "verified").length;
  const ctx = usageContext(slug, {
    catalog: catalog.data,
    packIds: (deliverables.data?.deliverables ?? [])
      .filter((d) => d.kind === "pack")
      .map((d) => d.id),
  });
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const sdkSetup = renderSdkSetup(sdk, {
    slug,
    origin,
    pins: data.snippet.pins,
    services: data.snippet.services,
    usage: ctx,
  });
  // Only some SDKs have a server lane: show the Node one rather than hide the card, so a Verified
  // server stays visible whatever client SDK is picked.
  const serverSdk = renderUsage("licensing", sdk, "server", null, ctx)
    ? sdk
    : "node";
  const server = renderUsage("licensing", serverSdk, "server", null, ctx);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integration"
        description={
          total === 0
            ? undefined
            : `${verified} of ${total} ${total === 1 ? "feature" : "features"} Verified`
        }
        freshness={{
          updatedAt: view.dataUpdatedAt,
          onRefresh: () => void view.refetch(),
          refreshing: view.isFetching,
        }}
      />
      {total === 0 ? (
        <EmptyState
          kind="first-run"
          title="No feature is turned on"
          description="Turn on a service to see what your app needs for it."
          primaryAction={
            <Button asChild>
              <Link to={r.services(slug)}>Enable services</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_25rem]">
          <div className="min-w-0 space-y-6">
            {data.features.map((f) => (
              <FeatureCard
                key={f.id}
                slug={slug}
                feature={f}
                sdk={sdk}
                onSdk={pick}
                order={order}
                ctx={ctx}
                now={data.now}
                open={q.feature === f.id}
                onRetry={() => void view.refetch()}
                action={
                  f.id === "licensing" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabledReason={licenseGate.disabledReason}
                      onClick={() => setLicenseOpen(true)}
                    >
                      Create a test license
                    </Button>
                  ) : undefined
                }
              />
            ))}
            {server ? (
              <section
                aria-labelledby="integration-server"
                className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
              >
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <h2
                    id="integration-server"
                    tabIndex={-1}
                    className="text-base font-semibold text-fg-strong focus-visible:outline-hidden"
                  >
                    Your server
                  </h2>
                  <span
                    className={
                      data.server.length > 0
                        ? "text-sm font-medium text-success"
                        : "text-sm text-fg-muted"
                    }
                  >
                    {data.server.length > 0 ? "Verified" : "Not seen yet"}
                  </span>
                </header>
                <p className="text-sm text-fg-muted">
                  A backend that checks the license a client sends.
                  {serverSdk !== sdk
                    ? ` ${SDK_LABELS[sdk]} has no server snippet; this one is ${SDK_LABELS[serverSdk]}.`
                    : ""}
                </p>
                <CodeBlock code={server.code} filename={server.filename} wrap />
                <p className="text-sm">
                  <a
                    className="inline-flex min-h-6 items-center gap-1 text-accent-fg underline underline-offset-4"
                    href={docsUrl(SDK_DOC_KEYS[serverSdk].ownUi)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Integrate directly with your own UI
                    <ExternalLink aria-hidden className="size-3.5" />
                    <span className="sr-only"> (opens the docs)</span>
                  </a>
                </p>
                {data.server.length > 0 ? (
                  <VerifiedOn seen={data.server} now={data.now} />
                ) : (
                  <p className="text-sm text-fg-muted">
                    <a
                      className="inline-flex min-h-6 items-center text-accent-fg underline underline-offset-4"
                      href={docsUrl("notSeenYet")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Not seen after running it?
                    </a>
                  </p>
                )}
              </section>
            ) : null}
          </div>
          <aside
            aria-labelledby="integration-app"
            className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5 lg:sticky lg:top-4"
          >
            <h2
              id="integration-app"
              className="text-base font-semibold text-fg-strong"
            >
              Your app
            </h2>
            <SdkTabs
              idPrefix={SDK_QUICK_START_ID}
              value={sdk}
              onChange={pick}
              order={order}
            >
              <SegmentedControl
                aria-label="Add the SDK"
                value={how}
                onChange={setHow}
                options={[
                  { value: "command", label: "One command" },
                  { value: "hand", label: "By hand" },
                ]}
              />
              {how === "command" ? (
                <>
                  <CodeBlock
                    code={`pkey sdk --lang ${sdk} --write`}
                    language="sh"
                    filename="Terminal"
                  />
                  <p className="text-sm text-fg-muted">
                    Run it in your app's repository. It writes the config file
                    with this product's pins.
                  </p>
                </>
              ) : (
                <SdkSetupBlocks
                  setup={sdkSetup}
                  staged={data.snippet.pins.length > 1}
                  showStart={false}
                />
              )}
            </SdkTabs>
            <PlatformMeters view={data} label="Progress by platform" />
          </aside>
        </div>
      )}
      {data.verified || hidden ? (
        <p className="flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
          <Button
            ref={foot}
            variant="ghost"
            size="sm"
            disabledReason={setup.allowed ? undefined : setup.disabledReason}
            onClick={() => void toggleHidden()}
          >
            {hidden ? "Show Integration" : "Hide Integration"}
          </Button>
          {hidden
            ? "Hidden from Overview."
            : "Hides the Overview card; still in ⌘K."}
        </p>
      ) : null}
      <CreateLicenseDialog
        slug={slug}
        open={licenseOpen}
        onOpenChange={setLicenseOpen}
      />
    </div>
  );
}
