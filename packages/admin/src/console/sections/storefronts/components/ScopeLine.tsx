import * as React from "react";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/** Under Storefronts (A-20.7): which platforms the listed stores are for, and where to add one. */
export function ScopeLine({
  slug,
  platforms,
}: {
  slug: string;
  platforms: string[];
}): React.ReactElement | null {
  if (platforms.length === 0) return null;
  return (
    <p className="text-sm text-fg-muted">
      Stores for {platforms.join(", ")} ·{" "}
      <Link
        to={r.plannedPlatforms(slug)}
        className="py-1 text-accent-fg underline underline-offset-2"
      >
        Add a platform
      </Link>
    </p>
  );
}
