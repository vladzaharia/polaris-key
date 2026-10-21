import * as React from "react";
import { ArrowRight } from "lucide-react";
import { formatRelative, fromSeconds } from "../../../../lib/format.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsSection } from "../../../templates/Settings.js";
import { useDelegations } from "../../release/data.js";

/**
 * Content keys are set by the release pipeline: this section lists the active ones, read-only,
 * and links to the full page.
 */
export function ContentKeysSection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const query = useDelegations(slug);
  const active =
    query.data?.delegations.filter((d) => d.status === "active") ?? [];
  const now = Date.now();
  return (
    <SettingsSection
      id="keys-content"
      title="Content keys"
      description="Set by the release pipeline. App release records are signed by your CI release key."
      actions={
        <Link
          to={r.contentKeys(slug)}
          className="inline-flex items-center gap-1 text-sm text-accent-fg underline-offset-4 hover:underline"
        >
          All content keys
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      }
    >
      {query.isPending ? (
        <div className="px-5 py-4" aria-label="content keys">
          <Skeleton className="h-6 w-full" />
        </div>
      ) : query.isError ? (
        <div className="px-5 py-4">
          <ErrorState
            compact
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : active.length === 0 ? (
        <p className="px-5 py-4 text-sm text-fg-muted">
          No active content keys.
        </p>
      ) : (
        <ul aria-label="Active content keys" className="divide-y divide-border">
          {active.map((d) => (
            <li
              key={d.sha256}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3"
            >
              <span className="font-mono text-sm text-fg-strong [overflow-wrap:anywhere]">
                {d.scope}.*
              </span>
              <span className="text-sm text-fg-muted">
                {d.effectiveTypes.join(", ")} · expires{" "}
                {formatRelative(fromSeconds(d.expiresAt), now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
