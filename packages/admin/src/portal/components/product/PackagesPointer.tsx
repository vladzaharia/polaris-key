import * as React from "react";
import { ArrowRight, Package } from "lucide-react";
import { href } from "../../router.js";
import { SectionCard } from "./Card.js";

/**
 * Packages on a product page (portal-11): one pointer row. Tokens and setup live only in
 * Account → Packages: a `pkeyp_` token is the account's, one per computer, and revoking it from
 * a product page would break every product's installs.
 */
export function PackagesPointer({
  productName,
  developer,
}: {
  productName: string;
  developer: string | null;
}): React.ReactElement {
  return (
    <SectionCard
      id="package"
      title={
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex size-9 items-center justify-center rounded-lg bg-surface-sunken">
            <Package aria-hidden className="size-5 text-fg-strong" />
          </span>
          Packages
        </span>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-fg">
          {productName} packages from {developer ?? "the developer"}
        </p>
        <a
          href={href.account("packages")}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-sm font-medium text-fg-strong underline underline-offset-2 hover:text-accent-fg"
        >
          Set up in Account → Packages
          <ArrowRight aria-hidden className="size-4" />
        </a>
      </div>
    </SectionCard>
  );
}
