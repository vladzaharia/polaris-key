/**
 * Core → Integration (ST-41; docs/research/2026-10-07-dx-consolidation/integration.md §3.2): what an
 * app needs to use each enabled feature, the code to put in it, and where the feature was seen
 * working. Reads ST-40's read model; every Verified fact is a successful SDK request, never a
 * checkbox, and "Hide Integration" is the operator's own choice (`core.setup`), never automatic.
 *
 * The SDK picker is a tablist per card; the pick is the hash query's `sdk=`.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { renderSdkSetup, renderUsage } from "@polaris-key/manifest/integration";
import { api } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { useLoadingAnnouncement } from "../../../../ui/loading.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { useWriteGate } from "../../../access/useCan.js";
import { qk } from "../../../data/queries.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { edit } from "../../../wizard/setup.js";
import { useSetup } from "../../../wizard/useSetup.js";
import { CreateLicenseDialog } from "../../license/components/CreateLicenseDialog.js";
import {
  FeatureCard,
  VerifiedOn,
} from "../components/IntegrationFeatureCard.js";
import { SdkSetupBlocks } from "../components/SdkSetupBlocks.js";
import { SdkTabs } from "../components/SdkTabs.js";
import {
  SDK_DOC_KEYS,
  defaultSdk,
  isSdkId,
  platformProgress,
  progress,
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
  const setup = useSetup(slug);
  const licenseGate = useWriteGate("license", slug);
  const [q, setQ] = useQueryParams(PARAMS);
  const [licenseOpen, setLicenseOpen] = React.useState(false);
  useLoadingAnnouncement("integration", view.isPending);

  const data = view.data;
  const sdk = isSdkId(q.sdk) ? q.sdk : defaultSdk(data);
  const pick = (id: string) => setQ({ sdk: id });
  const hidden = setup.choices.integrationHidden !== null;

  // A link from the Overview's next step lands on its feature's card.
  React.useEffect(() => {
    if (!data || !q.feature) return;
    document
      .getElementById(`integration-${q.feature}-card`)
      ?.scrollIntoView({ block: "start" });
  }, [data, q.feature]);

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

  const { verified, total } = progress(data);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const sdkSetup = renderSdkSetup(sdk, {
    slug,
    origin,
    pins: data.snippet.pins,
    services: data.snippet.services,
  });
  const server = renderUsage("licensing", sdk, "server", null, {});
  const platforms = platformProgress(data);

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
        secondaryActions={
          data.verified
            ? [
                hidden
                  ? {
                      label: "Show on Overview",
                      icon: <Eye aria-hidden />,
                      onSelect: () =>
                        void setup.save(edit.hideIntegration(null)),
                    }
                  : {
                      label: "Hide Integration",
                      icon: <EyeOff aria-hidden />,
                      onSelect: () =>
                        void setup.save(edit.hideIntegration(setup.stamp())),
                    },
              ]
            : []
        }
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
        <>
          {platforms.length > 0 ? (
            <ul
              aria-label="Progress by platform"
              className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-muted"
            >
              {platforms.map((p) => (
                <li key={p.platform}>
                  <span className="font-medium text-fg-strong">{p.label}</span>{" "}
                  {p.verified} of {p.total} Verified
                </li>
              ))}
            </ul>
          ) : null}
          <section
            aria-labelledby="integration-setup"
            className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
          >
            <h2
              id="integration-setup"
              className="text-base font-semibold text-fg-strong"
            >
              Install and configure
            </h2>
            <SdkTabs idPrefix={SDK_QUICK_START_ID} value={sdk} onChange={pick}>
              <SdkSetupBlocks
                setup={sdkSetup}
                staged={data.snippet.pins.length > 1}
                showStart={false}
              />
            </SdkTabs>
          </section>
          {data.features.map((f) => (
            <FeatureCard
              key={f.id}
              slug={slug}
              feature={f}
              sdk={sdk}
              onSdk={pick}
              now={data.now}
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
              <h2
                id="integration-server"
                className="text-base font-semibold text-fg-strong"
              >
                Your server
              </h2>
              <p className="text-sm text-fg-muted">
                A backend that checks the license a client sends.{" "}
                <a
                  className="text-accent-fg underline underline-offset-4"
                  href={docsUrl(SDK_DOC_KEYS[sdk].ownUi)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Integrate directly with the library
                </a>
              </p>
              <CodeBlock code={server.code} filename={server.filename} wrap />
              {data.server.length > 0 ? (
                <>
                  <p className="text-sm font-medium text-success">Verified</p>
                  <VerifiedOn seen={data.server} now={data.now} />
                </>
              ) : (
                <p className="text-sm text-fg-muted">
                  Not seen yet.{" "}
                  <a
                    className="text-accent-fg underline underline-offset-4"
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
        </>
      )}
      <CreateLicenseDialog
        slug={slug}
        open={licenseOpen}
        onOpenChange={setLicenseOpen}
      />
    </div>
  );
}
