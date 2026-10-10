import * as React from "react";
import type { ConsoleEnvironment } from "../../api.js";
import { cn } from "../../lib/cn.js";

const LABEL: Record<Exclude<ConsoleEnvironment, "prod">, string> = {
  staging: "Staging",
  dev: "Dev",
};

/**
 * Which deployment this console is (ADMIN.md §2.2): "Staging" in the warning tone, "Dev" in info,
 * nothing in production. The source is `/me.environment` (A-1), never a hostname heuristic, and
 * an unset environment renders nothing, exactly like production.
 */
export function EnvironmentBadge({
  environment,
  className,
}: {
  environment: ConsoleEnvironment | null | undefined;
  className?: string;
}): React.ReactElement | null {
  if (environment !== "staging" && environment !== "dev") return null;
  return (
    <span
      data-environment={environment}
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-2 py-0.5 text-xs font-medium",
        environment === "staging"
          ? "border-warning-border bg-warning-subtle text-warning"
          : "border-info-border bg-info-subtle text-info",
        className,
      )}
    >
      <span className="sr-only">Environment: </span>
      {LABEL[environment]}
    </span>
  );
}
