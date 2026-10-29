/**
 * The two install cards at the foot of Packages (F-34.10, mockup `packages.feeds`): where people
 * install from. A person's machine runs `pkey feeds setup --write`; CI and servers read a Service
 * token from an environment variable. Both commands come from `@polaris-key/manifest`, the
 * strings the CLI itself uses, and neither shows a token: the CI card names the variable.
 */

import * as React from "react";
import {
  FEEDS_CI_TOKEN_ENV,
  FEEDS_SETUP_WRITE_COMMAND,
  feedsSetupCiCommand,
} from "@polaris-key/manifest";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { Section } from "../../../../ui/Section.js";
import { Link } from "../../../router.js";
import { tokensHref, type FeedScope } from "../model/model.js";

function Command({
  command,
  label,
}: {
  command: string;
  label: string;
}): React.ReactElement {
  return (
    <div
      data-install-command=""
      className="flex items-center gap-2 rounded-lg border border-border bg-surface-page px-3 py-2"
    >
      <span
        aria-hidden
        className="select-none font-mono text-xs text-fg-subtle"
      >
        $
      </span>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="pk-scroll min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-1 font-mono text-xs"
      >
        {command}
      </div>
      <CopyButton value={command} label={`Copy: ${label}`} size="xs" />
    </div>
  );
}

export function InstallCards({
  scope,
  owner,
  ecosystem,
}: {
  scope: FeedScope;
  /** The feed owner's slug, for the CI command. */
  owner: string;
  /** A provisioned feed's ecosystem, for the CI command. */
  ecosystem: string;
}): React.ReactElement {
  return (
    <div
      data-install-cards=""
      className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"
    >
      <Section title="Install on your machine">
        <div className="space-y-2 text-sm">
          <Command
            command={FEEDS_SETUP_WRITE_COMMAND}
            label="Install on your machine"
          />
          <p className="m-0 text-fg-muted">
            Signs in and sets up your package tools.
          </p>
        </div>
      </Section>
      <Section title="Install in CI and on servers">
        <div className="space-y-2 text-sm">
          <Command
            command={feedsSetupCiCommand(ecosystem, owner)}
            label="Install in CI and on servers"
          />
          <p className="m-0 text-fg-muted">
            Reads the Service token from <code>{FEEDS_CI_TOKEN_ENV}</code>.{" "}
            <Link
              to={tokensHref(scope)}
              className="text-accent-fg underline underline-offset-2"
            >
              Create a Service token
            </Link>
          </p>
        </div>
      </Section>
    </div>
  );
}
