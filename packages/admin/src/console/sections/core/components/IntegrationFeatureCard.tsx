/**
 * One feature on the Integration page (ST-41): what it still needs, the code for the picked SDK,
 * and where it was seen working. Verified means an SDK made a successful request after the
 * feature's setup was done (ST-40); `sdkVersion` is the client's own claim and shows as text only.
 */

import * as React from "react";
import { Check, Circle, CircleAlert, ExternalLink } from "lucide-react";
import {
  SDK_LABELS,
  renderUsage,
  type SdkId,
  type UsageContext,
} from "@polaris-key/manifest/integration";
import type {
  IntegrationFeature,
  IntegrationVerifiedOn,
} from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { Link } from "../../../router.js";
import {
  FEATURE_LABEL,
  SDK_DOC_KEYS,
  byPlatform,
  prerequisiteInfo,
} from "../model/integration.js";
import { codeLanguage } from "../model/sdkQuickStart.js";
import { SdkTabs } from "./SdkTabs.js";

const STATUS = {
  verified: { word: "Verified", Icon: Check, cls: "text-success" },
  not_seen: { word: "Not seen yet", Icon: Circle, cls: "text-fg-muted" },
  blocked: { word: "Waiting on setup", Icon: CircleAlert, cls: "text-warning" },
} as const;

export function FeatureStatus({
  status,
}: {
  status: IntegrationFeature["status"];
}): React.ReactElement {
  const { word, Icon, cls } = STATUS[status];
  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1 text-sm font-medium ${cls}`}
    >
      <Icon aria-hidden className="size-4" />
      {word}
    </span>
  );
}

/** Where a feature or the server lane was seen: a row per platform, text only. */
export function VerifiedOn({
  seen,
  now,
}: {
  seen: readonly IntegrationVerifiedOn[];
  now: number;
}): React.ReactElement {
  return (
    <ul aria-label="Verified on" className="divide-y divide-border text-sm">
      {byPlatform(seen).map((row) => (
        <li
          key={row.platform}
          className="flex flex-wrap gap-x-3 gap-y-1 py-1.5"
        >
          <span className="font-medium text-fg-strong">{row.label}</span>
          <span className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">
            {row.seen
              .map(
                (s) =>
                  `${SDK_LABELS[s.sdk.replace(/-server$/, "") as SdkId] ?? s.sdk}${
                    s.sdkVersion ? ` ${s.sdkVersion}` : ""
                  }${s.arch ? ` · ${s.arch}` : ""}`,
              )
              .join(", ")}
          </span>
          {row.seen[0]?.lastOkAt ? (
            <Timestamp
              className="ml-auto text-fg-muted"
              at={fromSeconds(row.seen[0].lastOkAt)}
              format="relative"
              now={fromSeconds(now)}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const LINK =
  "inline-flex min-h-6 items-center gap-1 text-accent-fg underline underline-offset-4";

export function FeatureCard({
  slug,
  feature,
  sdk,
  onSdk,
  order,
  ctx,
  now,
  action,
  open: forceOpen = false,
  onRetry,
}: {
  slug: string;
  feature: IntegrationFeature;
  sdk: SdkId;
  onSdk: (sdk: SdkId) => void;
  order: readonly SdkId[];
  /** This product's names for the snippets. */
  ctx: Partial<UsageContext>;
  now: number;
  /** The feature's own button (the inline test licence). */
  action?: React.ReactNode;
  /** Opens a folded card (a link named this feature). */
  open?: boolean;
  /** Reads the Integration model again (a step that could not be read). */
  onRetry: () => void;
}): React.ReactElement {
  const label = FEATURE_LABEL[feature.id];
  const done =
    feature.status === "verified" &&
    !feature.unavailable &&
    feature.prerequisites.every((p) => p.met);
  const [expanded, setExpanded] = React.useState(false);
  const folded = done && !expanded && !forceOpen;
  const headingId = `integration-${feature.id}`;
  const bodyId = `${headingId}-body`;
  const block =
    renderUsage(feature.id, sdk, "kit", null, ctx) ??
    renderUsage(feature.id, sdk, "library", null, ctx);
  const docs = SDK_DOC_KEYS[sdk];
  const runnable = block !== null && block.status !== "planned";
  return (
    <section
      aria-labelledby={headingId}
      data-service={feature.service}
      data-feature={feature.id}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={headingId}
          tabIndex={-1}
          className="text-base font-semibold text-fg-strong focus-visible:outline-hidden"
        >
          {label}
        </h2>
        <span className="flex items-center gap-3">
          <FeatureStatus status={feature.status} />
          {done && !forceOpen ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${folded ? "Show" : "Hide"} ${label}`}
              aria-expanded={!folded}
              aria-controls={bodyId}
              onClick={() => setExpanded((v) => !v)}
            >
              {folded ? "Show" : "Hide"}
            </Button>
          ) : null}
        </span>
      </header>
      <div
        id={bodyId}
        hidden={folded}
        className={folded ? "hidden" : "flex flex-col gap-4"}
      >
        {feature.unavailable ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            Its setup steps could not be read just now.
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </p>
        ) : feature.prerequisites.length > 0 ? (
          <ul aria-label={`${label} setup`} className="divide-y divide-border">
            {feature.prerequisites.map((p) => {
              const info = prerequisiteInfo(p.id, slug);
              return (
                <li
                  key={p.id}
                  data-state={p.met ? "met" : "open"}
                  className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
                >
                  {p.met ? (
                    <Check aria-hidden className="size-4 text-success" />
                  ) : (
                    <Circle aria-hidden className="size-4 text-fg-muted" />
                  )}
                  <span className="min-w-0 flex-1 text-fg">
                    {info.label}
                    <span className="sr-only">
                      {p.met ? ", done" : ", to do"}
                    </span>
                  </span>
                  {p.met ? null : (
                    <Button asChild variant="outline" size="sm">
                      <Link to={info.href}>{info.action}</Link>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        <SdkTabs
          idPrefix={`${headingId}-sdk`}
          value={sdk}
          onChange={onSdk}
          order={order}
        >
          {block ? (
            block.status === "planned" ? (
              <p className="text-sm text-fg-muted">
                Not available in {SDK_LABELS[sdk]} yet.
              </p>
            ) : (
              <>
                <CodeBlock
                  code={block.code}
                  language={codeLanguage(block.language)}
                  filename={block.filename}
                  wrap
                />
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <a
                    className={LINK}
                    href={docsUrl(docs.customise)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Customize the screens
                    <ExternalLink aria-hidden className="size-3.5" />
                    <span className="sr-only"> (opens the docs)</span>
                  </a>
                  <a
                    className={LINK}
                    href={docsUrl(docs.ownUi)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Integrate directly with your own UI
                    <ExternalLink aria-hidden className="size-3.5" />
                    <span className="sr-only"> (opens the docs)</span>
                  </a>
                </p>
              </>
            )
          ) : (
            <p className="text-sm text-fg-muted">
              {SDK_LABELS[sdk]} has no {label.toLowerCase()} code yet.
            </p>
          )}
        </SdkTabs>
        {action}
        {feature.status === "verified" ? (
          <VerifiedOn seen={feature.verifiedOn} now={now} />
        ) : feature.status === "not_seen" && runnable ? (
          <p className="text-sm text-fg-muted">
            Run your app once against this product.{" "}
            <a
              className={LINK}
              href={docsUrl("notSeenYet")}
              target="_blank"
              rel="noreferrer"
            >
              Not seen after running it?
            </a>
          </p>
        ) : null}
      </div>
    </section>
  );
}
