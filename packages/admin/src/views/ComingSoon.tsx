import * as React from "react";
import { Construction } from "lucide-react";
import { EmptyState } from "../components/ui/index.js";

/**
 * Placeholder for a view another agent will build on this foundation. Renders a labelled
 * empty state so the app compiles + navigates with every route reachable today.
 */
export function ComingSoon({
  title,
  description,
}: {
  title: string;
  description?: string;
}): React.ReactElement {
  return (
    <section aria-labelledby="view-title" className="space-y-4">
      <header>
        <h2 id="view-title" className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
      </header>
      <EmptyState
        icon={<Construction aria-hidden />}
        title={`${title} — coming soon`}
        description={
          description ??
          "This view will be built on the Polaris Key foundation."
        }
      />
    </section>
  );
}
