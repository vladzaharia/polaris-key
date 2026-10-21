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
  pinFingerprint,
  renderSdkSetup,
  sdkAddCommand,
  type PinFingerprint,
  renderUsage,
} from "@polaris-key/manifest/integration";
import { api } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { useProduct } from "../../../data/hooks.js";
import { qk } from "../../../data/queries.js";
import { Link, navigate } from "../../../router.js";
import { r } from "../../../routes.js";
import { focusWhenReady } from "../../../shell/palette/focus.js";
import { MomentLine, momentKey } from "../../../components/Moment.js";
import { useSetup } from "../../../wizard/useSetup.js";
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

const PARAMS = ["sdk", "feature", "created"] as const;

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
  const product = useProduct(slug);
  const signingKey = product.data?.signing?.publicKey;
  const pins = data?.snippet.pins;
  const [prints, setPrints] = React.useState<PinFingerprint[]>([]);
  React.useEffect(() => {
    let live = true;
    void Promise.all(
      (pins ?? []).map(async (p) => ({
        kid: p.kid,
        fingerprint: await pinFingerprint(p.publicKey),
      })),
    )
      .then((l) => live && setPrints(l))
      .catch(() => live && setPrints([]));
    return () => {
      live = false;
    };
  }, [pins]);
  const setup = useSetup(slug);
  const licenseGate = useWriteGate("license", slug);
  const [q, setQ] = useQueryParams(PARAMS);
  // Arriving from New product (ST-43): the product's first moment shows once; the link is then
  // a plain Integration link, so a refresh or a share does not repeat it.
  const [justCreated] = React.useState(q.created === "1");
  // The shell focused the skeleton's heading; the page's own heading replaces it once the data is
  // in, so focus goes to that one (a route change leaves focus on the h1, not on the body).
  const loaded = view.data !== undefined;
  React.useEffect(() => {
    if (!justCreated || !loaded) return;
    const h1 = document.querySelector<HTMLElement>("h1[data-page-title]");
    if (!h1) return;
    if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
    h1.focus({ preventScroll: true });
    // Said once, in the polite region (a line that mounts with its text is not announced), after
    // the page's own "loaded".
    const t = window.setTimeout(
      () => announce(`${product.data?.name ?? slug} is ready`),
      400,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justCreated, loaded]);
  React.useEffect(() => {
    if (justCreated) setQ({ created: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    releaseKeys: data.snippet.releaseKeys,
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
      {justCreated ? (
        <MomentLine
          momentKey={momentKey("product-created", slug)}
          title={`${product.data?.name ?? slug} is ready`}
          className="rounded-xl border border-border bg-surface-raised px-5 py-3"
        >
          Signed by {data.snippet.pins[0]?.kid ?? "its key"}. Connect your app
          below.
        </MomentLine>
      ) : null}
      {total === 0 ? (
        <EmptyState
          kind="first-run"
          title="No feature is turned on"
          description="Turn on a feature to see what your app needs for it."
          primaryAction={
            <Button asChild>
              <Link to={r.services(slug)}>Enable features</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,56rem)_25rem]">
          <aside
            aria-labelledby="integration-app"
            className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto"
          >
            <h2
              id="integration-app"
              className="text-base font-semibold text-fg-strong"
            >
              Your app
            </h2>
            {!signingKey ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm">
                <span className="text-fg">No signing key is active.</span>
                <Button asChild variant="outline" size="sm">
                  <Link to={r.keys(slug)}>Activate a signing key</Link>
                </Button>
              </div>
            ) : null}
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
                  {prints.length > 0 ? (
                    <CodeBlock
                      code={sdkAddCommand(
                        sdk,
                        slug,
                        prints,
                        data.snippet.releaseKeys,
                      )}
                      language="sh"
                      filename="Terminal"
                      wrap
                    />
                  ) : (
                    <p className="text-sm text-fg-muted">
                      The command needs this product's pins, from an active
                      signing key.
                    </p>
                  )}
                  <p className="text-sm text-fg-muted">
                    Run it in your app's folder. It checks these pins before it
                    writes the config file.
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
            {prints.length > 0 ? (
              <div className="space-y-1.5">
                <h3 className="text-sm font-medium text-fg-strong">
                  Trust pins
                </h3>
                <ul className="space-y-1.5">
                  {prints.map((p) => (
                    <li key={p.kid} className="space-y-0.5">
                      <p className="text-xs text-fg-muted">{p.kid}</p>
                      <p className="flex items-center gap-1">
                        <code className="min-w-0 flex-1 font-mono text-xs text-fg [overflow-wrap:anywhere]">
                          sha256:{p.fingerprint}
                        </code>
                        <CopyButton
                          value={`${p.kid}@sha256:${p.fingerprint}`}
                          label={`Copy the ${p.kid} pin`}
                        />
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <PlatformMeters view={data} label="Progress by platform" />
          </aside>
          <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
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
                      onClick={() =>
                        navigate(r.newLicense(slug), { replace: false })
                      }
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
        </div>
      )}
      {data.verified || hidden ? (
        <p className="text-sm text-fg-muted">
          <Button
            ref={foot}
            variant="link"
            size="sm"
            className="h-auto p-0 text-sm"
            disabledReason={setup.allowed ? undefined : setup.disabledReason}
            onClick={() => void toggleHidden()}
          >
            {hidden ? "Show Integration" : "Hide Integration"}
          </Button>{" "}
          {hidden
            ? "Hidden from Overview."
            : "Hides the Overview card. Search still finds this page."}
        </p>
      ) : null}
    </div>
  );
}
