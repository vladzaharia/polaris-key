import * as React from "react";
import { ChevronRight } from "lucide-react";
import type { LibraryProduct, QuickAction } from "../model/library.js";
import { href } from "../router.js";
import { ProductIcon } from "./ProductIcon.js";
import { ProductStatusPill } from "./ProductStatus.js";
import { QuickActionButton } from "./QuickAction.js";

/**
 * The list view (§4.15): icon · Product · Status · Latest · Devices · Quick action · chevron,
 * 72 px rows, the whole row opening the product page. Phones drop the columns and keep the status
 * as a pill under the name (§8). A native table: the console's data-table brings operator chrome
 * (columns menu, density, CSV) this list doesn't have.
 */
export function LibraryList({
  products,
  actionFor,
  actionHeader,
}: {
  products: readonly LibraryProduct[];
  actionFor: (p: LibraryProduct) => QuickAction;
  /** "Quick action for this Mac". */
  actionHeader: string;
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Your products</caption>
        <thead className="hidden text-xs text-fg-muted desk:table-header-group">
          <tr className="border-b border-border">
            <th scope="col" className="py-3 pl-5 pr-2 font-normal">
              <span className="sr-only">Icon</span>
            </th>
            <th scope="col" className="px-2 py-3 font-normal">
              Product
            </th>
            <th scope="col" className="px-2 py-3 font-normal">
              Status
            </th>
            <th
              scope="col"
              className="hidden px-2 py-3 font-normal wide:table-cell"
            >
              Latest
            </th>
            <th
              scope="col"
              className="hidden px-2 py-3 font-normal wide:table-cell"
            >
              Devices
            </th>
            <th scope="col" className="px-2 py-3 text-right font-normal">
              {actionHeader}
            </th>
            <th scope="col" className="py-3 pr-5 font-normal">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr
              key={p.slug}
              className="relative border-b border-border last:border-0 hover:bg-hover"
            >
              <td className="w-0 py-3 pl-4 pr-2 desk:pl-5">
                <ProductIcon
                  slug={p.slug}
                  name={p.name}
                  tint={p.presentation.tint}
                  src={p.presentation.iconUrl}
                  size={48}
                />
              </td>
              <td className="px-2 py-3">
                <a
                  href={href.product(p.slug)}
                  className="font-bold text-fg-strong after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                >
                  {p.name}
                </a>
                {p.presentation.developer ? (
                  <span className="block text-sm text-fg-muted">
                    {p.presentation.developer}
                  </span>
                ) : null}
                <span className="mt-1 block desk:hidden">
                  <ProductStatusPill status={p.status} />
                </span>
              </td>
              <td className="hidden px-2 py-3 desk:table-cell">
                <ProductStatusPill status={p.status} />
              </td>
              <td className="hidden px-2 py-3 font-mono text-sm text-fg wide:table-cell">
                {p.latestVersion ?? "–"}
              </td>
              <td className="hidden px-2 py-3 text-sm text-fg wide:table-cell">
                {p.status.kind === "signedInApp"
                  ? "Any device"
                  : p.seats
                    ? `${p.seats.inUse} of ${p.seats.limit}`
                    : p.deviceCount}
              </td>
              <td className="relative hidden px-2 py-3 text-right desk:table-cell">
                <QuickActionButton
                  product={p}
                  action={actionFor(p)}
                  size="md"
                  className="h-10"
                />
              </td>
              <td className="w-0 py-3 pr-4 desk:pr-5">
                <ChevronRight aria-hidden className="size-5 text-fg-muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
