/** Package feeds, platform scope: the owners list and the bootstrap prompt (split from `FeedsArea.tsx`). */

import * as React from "react";
import { Rocket } from "lucide-react";
import type { FeedsOverviewDto } from "../../../../api.js";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { intentOf } from "../../core/pages/confirmGate.js";

/** Platform scope: every product whose package feeds have been switched, the system one first. */
export function OwnersPanel({
  owners,
}: {
  owners: NonNullable<FeedsOverviewDto["owners"]>;
}): React.ReactElement {
  return (
    <section
      aria-labelledby="feeds-owners"
      className="rounded-lg border border-border bg-surface-raised p-5"
    >
      <h2 id="feeds-owners" className="text-sm font-semibold text-fg-strong">
        Owners
      </h2>
      <p className="mt-1 text-sm text-fg-muted">
        Each under its own path on the registry host.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {owners.map((o) => (
          <li
            key={o.slug}
            className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
          >
            <span className="flex items-center gap-2">
              {o.system ? (
                <span className="text-fg-strong">{o.name}</span>
              ) : (
                <Link
                  to={r.packageFeeds(o.slug)}
                  className="py-1 text-accent-fg underline-offset-4 hover:underline"
                >
                  {o.name}
                </Link>
              )}
              <span className="font-mono text-xs text-fg-muted">{o.slug}</span>
              {o.system ? (
                <StatusPill tone="neutral" icon={null} size="sm">
                  Platform
                </StatusPill>
              ) : null}
            </span>
            {o.packageFeeds ? (
              <StatusPill tone="success" size="sm">
                On
              </StatusPill>
            ) : (
              <StatusPill tone="neutral" size="sm">
                Off
              </StatusPill>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Platform scope before the bootstrap: the system product does not exist yet. */
export function BootstrapEmpty(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <EmptyState
        kind="first-run"
        title="The platform's package feeds are not set up"
        description="Setting them up creates the platform's own product, which owns the SDK packages, and one feed per ecosystem with the platform's namespaces."
        primaryAction={
          <Button
            iconStart={<Rocket aria-hidden />}
            onClick={() => setOpen(true)}
          >
            Set up platform feeds…
          </Button>
        }
        docs={docsUrl("packageFeeds")}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        intent={intentOf("feed.bootstrap")}
        title="Set up the platform's package feeds?"
        consequences={[
          "Creates the platform's own product, polaris-key, with a signing key sealed under the platform key. It stays out of the product switcher and the Products registry.",
          "Turns on Release, Distribution and package feeds for it, with one feed per ecosystem under the platform's namespaces.",
          "Running it again changes nothing an operator has set since.",
        ]}
        confirmLabel="Set up platform feeds"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("bootstrapPlatformFeeds");
          toast.success("The platform's package feeds are set up");
        }}
      />
    </>
  );
}
