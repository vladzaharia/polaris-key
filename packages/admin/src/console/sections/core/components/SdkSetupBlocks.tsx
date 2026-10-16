/**
 * The install, configuration and start blocks of Overview's SDK quick start, from `renderSdkSetup`
 * (SP-33a). Install comes first with its registry line; the configuration carries the trust pins;
 * the start is the drop-in only.
 */

import * as React from "react";
import type { SdkSetup } from "@polaris-key/manifest/integration";
import { Callout } from "../../../../ui/Callout.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { codeLanguage } from "../model/sdkQuickStart.js";

export function SdkSetupBlocks({
  setup,
  staged,
}: {
  setup: SdkSetup;
  staged: boolean;
}): React.ReactElement {
  const { install, installNote, config, start, warnings } = setup;
  return (
    <>
      <p className="text-sm text-fg-muted">
        Every Polaris Key SDK installs from pkg.plrs.im, and only from there:
        route the package name to it before installing.
      </p>
      {install.map((s) => (
        <div key={s.id} className="space-y-1.5">
          <p className="text-xs font-semibold text-fg-muted">{s.title}</p>
          {s.warning ? <Callout tone="warning">{s.warning}</Callout> : null}
          {s.description ? (
            <p className="text-sm text-fg-muted">{s.description}</p>
          ) : null}
          <CodeBlock
            code={s.code}
            language={s.language}
            filename={s.filename}
            wrap
          />
        </div>
      ))}
      {installNote ? (
        <p className="text-sm text-fg-muted">{installNote}</p>
      ) : null}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg-muted">
          Configuration, with your trust pins
        </p>
        {staged ? (
          <p className="text-sm text-fg-muted">
            Pins the active key and the key staged to replace it, so this build
            keeps working after the rotation.
          </p>
        ) : null}
        {warnings.map((w) => (
          <Callout key={w} tone="warning">
            {w}
          </Callout>
        ))}
        <CodeBlock
          code={config.code}
          language={codeLanguage(config.language)}
          filename={config.filename}
          wrap
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg-muted">{start.title}</p>
        <CodeBlock
          code={start.code}
          language={codeLanguage(start.language)}
          filename={start.filename}
          wrap
        />
      </div>
    </>
  );
}
