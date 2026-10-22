/**
 * The Integration page's two host cards beside the app (framework drop-ins plan §10, SP-64): "Your
 * server" (a backend that verifies the license an app sends) and "Your CLI" (the terminal kit
 * mounted in a command-line program). With no linked repo the developer picks the framework; the
 * snippet is the framework's own, with this product's names. Each card draws only what the
 * generator renders for the picked SDK, and nothing where it renders none.
 */

import * as React from "react";
import { ExternalLink } from "lucide-react";
import {
  SDK_LABELS,
  renderUsage,
  type SdkId,
  type UsageContext,
} from "@polaris-key/manifest/integration";
import type { IntegrationVerifiedOn } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { Select } from "../../../../ui/Select.js";
import {
  SDK_DOC_KEYS,
  frameworkLabel,
  hostFrameworks,
  pickFramework,
  rendererFramework,
  serverSdkFor,
} from "../model/integration.js";
import { codeLanguage } from "../model/sdkQuickStart.js";
import { VerifiedOn } from "./IntegrationFeatureCard.js";

const LINK =
  "inline-flex min-h-6 items-center gap-1 text-accent-fg underline underline-offset-4";

function DocsLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <a className={LINK} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> (opens the docs)</span>
    </a>
  );
}

function FrameworkSelect({
  id,
  sdk,
  host,
  value,
  onChange,
}: {
  id: string;
  sdk: SdkId;
  host: "server" | "cli";
  value: string | null;
  onChange: (framework: string) => void;
}): React.ReactElement | null {
  const options = hostFrameworks(sdk, host);
  if (options.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-sm font-medium text-fg-strong">
        Framework
      </label>
      <div className="w-56 max-w-full">
        <Select
          id={id}
          options={options}
          value={value}
          onChange={(v) => v && onChange(v)}
        />
      </div>
    </div>
  );
}

export function ServerCard({
  sdk,
  ctx,
  framework,
  onFramework,
  seen,
  now,
}: {
  sdk: SdkId;
  ctx: Partial<UsageContext>;
  framework: string | null;
  onFramework: (framework: string) => void;
  /** The `<lang>-server` sightings: Verified once there is one. */
  seen: readonly IntegrationVerifiedOn[];
  now: number;
}): React.ReactElement | null {
  const serverSdk = serverSdkFor(sdk);
  const picked = pickFramework(serverSdk, "server", framework);
  const block = renderUsage(
    "licensing",
    serverSdk,
    "server",
    rendererFramework(picked),
    ctx,
  );
  if (!block) return null;
  const verified = seen.length > 0;
  return (
    <section
      aria-labelledby="integration-server"
      data-host="server"
      className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="integration-server"
          tabIndex={-1}
          className="text-base font-semibold text-fg-strong"
        >
          Your server
        </h2>
        <span
          className={
            verified
              ? "text-sm font-medium text-success"
              : "text-sm text-fg-muted"
          }
        >
          {verified ? "Verified" : "Not seen yet"}
        </span>
      </header>
      <p className="text-sm text-fg-muted">
        A backend that checks the license a client sends.
        {serverSdk !== sdk
          ? ` ${SDK_LABELS[sdk]} has no server snippet; this one is ${SDK_LABELS[serverSdk]}.`
          : ""}
      </p>
      <FrameworkSelect
        id="integration-server-framework"
        sdk={serverSdk}
        host="server"
        value={picked}
        onChange={onFramework}
      />
      <CodeBlock
        code={block.code}
        language={codeLanguage(block.language)}
        filename={block.filename}
        wrap
      />
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <DocsLink href={docsUrl("serverVerify")}>
          Verify on your server
        </DocsLink>
        <DocsLink href={docsUrl("serverCore")}>Use the core directly</DocsLink>
      </p>
      {verified ? (
        <VerifiedOn seen={seen} now={now} />
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
  );
}

export function CliCard({
  sdk,
  ctx,
  framework,
  onFramework,
}: {
  sdk: SdkId;
  ctx: Partial<UsageContext>;
  framework: string | null;
  onFramework: (framework: string) => void;
}): React.ReactElement | null {
  const picked = pickFramework(sdk, "cli", framework);
  if (!picked) return null;
  const block = renderUsage("licensing", sdk, "kit", picked, ctx);
  if (!block) return null;
  return (
    <section
      aria-labelledby="integration-cli"
      data-host="cli"
      className="space-y-4 rounded-xl border border-border bg-surface-raised p-4 sm:p-5"
    >
      <h2
        id="integration-cli"
        tabIndex={-1}
        className="text-base font-semibold text-fg-strong"
      >
        Your CLI
      </h2>
      <p className="text-sm text-fg-muted">
        The Polaris Key commands in a {frameworkLabel(picked)} program, and a
        command only a licensed person can run.
      </p>
      <FrameworkSelect
        id="integration-cli-framework"
        sdk={sdk}
        host="cli"
        value={picked}
        onChange={onFramework}
      />
      <CodeBlock
        code={block.code}
        language={codeLanguage(block.language)}
        filename={block.filename}
        wrap
      />
      <p className="text-sm">
        <DocsLink href={docsUrl(SDK_DOC_KEYS[sdk].customise)}>
          Customize the screens
        </DocsLink>
      </p>
    </section>
  );
}
