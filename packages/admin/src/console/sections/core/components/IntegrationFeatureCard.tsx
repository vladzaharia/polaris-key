/**
 * One feature on the Integration page (ST-41): what it still needs, the code for the picked SDK,
 * and where it was seen working. Verified means an SDK made a successful request after the
 * feature's setup was done (ST-40); `sdkVersion` is the client's own claim and shows as text only.
 */

import * as React from "react";
import { Check, Circle, CircleAlert } from "lucide-react";
import {
  SDK_LABELS,
  renderUsage,
  type SdkId,
} from "@polaris-key/manifest/integration";
import type {
  IntegrationFeature,
  IntegrationVerifiedOn,
} from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { PrereqList, type Prereq } from "../../../../ui/wizard/index.js";
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

export function FeatureCard({
  slug,
  feature,
  sdk,
  onSdk,
  now,
  action,
}: {
  slug: string;
  feature: IntegrationFeature;
  sdk: SdkId;
  onSdk: (sdk: SdkId) => void;
  now: number;
  /** The feature's own button (the inline test licence). */
  action?: React.ReactNode;
}): React.ReactElement {
  const label = FEATURE_LABEL[feature.id];
  const rows: Prereq[] = feature.prerequisites.map((p) => {
    const info = prerequisiteInfo(p.id, slug);
    return {
      id: p.id,
      label: info.label,
      state: p.met ? "met" : "unmet",
      fix: (
        <Button asChild variant="outline" size="sm">
          <Link to={info.href}>{info.action}</Link>
        </Button>
      ),
    };
  });
  const block =
    renderUsage(feature.id, sdk, "kit", null, {}) ??
    renderUsage(feature.id, sdk, "library", null, {});
  const docs = SDK_DOC_KEYS[sdk];
  const headingId = `integration-${feature.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-service={feature.service}
      data-feature={feature.id}
      id={headingId + "-card"}
      className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-fg-strong">
          {label}
        </h2>
        <FeatureStatus status={feature.status} />
      </header>
      {feature.unavailable ? (
        <p className="text-sm text-fg-muted">
          Its setup steps could not be read just now. Reload to try again.
        </p>
      ) : rows.length > 0 ? (
        <PrereqList rows={rows} label={`${label} setup`} />
      ) : null}
      <SdkTabs idPrefix={`${headingId}-sdk`} value={sdk} onChange={onSdk}>
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
                  className="text-accent-fg underline underline-offset-4"
                  href={docsUrl(docs.customise)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Customise the screens
                </a>
                <a
                  className="text-accent-fg underline underline-offset-4"
                  href={docsUrl(docs.ownUi)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Integrate directly with the library
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
      ) : feature.status === "not_seen" ? (
        <p className="text-sm text-fg-muted">
          Run your app once against this product.{" "}
          <a
            className="text-accent-fg underline underline-offset-4"
            href={docsUrl("notSeenYet")}
            target="_blank"
            rel="noreferrer"
          >
            Not seen after running it?
          </a>
        </p>
      ) : null}
    </section>
  );
}
