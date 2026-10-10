import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn.js";
import {
  isDownloadAction,
  type LibraryProduct,
  type QuickAction,
} from "../model/library.js";
import { href } from "../router.js";
import { useCueOnce } from "../stagger.js";
import { ProductIcon } from "./ProductIcon.js";
import { ProductStatusPill } from "./ProductStatus.js";
import { QuickActionButton } from "./QuickAction.js";

/**
 * The list view (§4.15): icon · Product · Status · Latest · Devices · Quick action · chevron,
 * 72 px rows, the whole row opening the product page. Phones drop the columns and keep the status
 * as a pill under the name (§8). A native table: the console's data-table brings operator chrome
 * (columns menu, density, CSV) this list doesn't have.
 *
 * `bodyRef` and `bodyClassName` go on the `tbody`, whose rows are the list's items: the Library's
 * first-load stagger (MO-07) puts `.pk-stagger` there.
 *
 * A just-added product's row (PX-24) says "Added just now" under its name, carries the ring inside
 * its edges and leads with its download, as its tile does (`LibraryTile`).
 */
export function LibraryList({
  products,
  actionFor,
  actionHeader,
  bodyRef,
  bodyClassName,
}: {
  products: readonly LibraryProduct[];
  actionFor: (p: LibraryProduct) => QuickAction;
  /** "Quick action for this Mac". */
  actionHeader: string;
  bodyRef?: React.Ref<HTMLTableSectionElement>;
  bodyClassName?: string;
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
        <tbody ref={bodyRef} className={bodyClassName}>
          {products.map((p) => (
            <LibraryRow key={p.slug} product={p} action={actionFor(p)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LibraryRow({
  product: p,
  action,
}: {
  product: LibraryProduct;
  action: QuickAction;
}): React.ReactElement {
  const cue = useCueOnce(p.slug, p.justAdded);
  const developer = p.presentation.developer;
  return (
    <tr
      ref={cue.ref}
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
        {p.justAdded ? (
          // The ring, inset from the row's edges so the list's rounded frame never clips it.
          <span
            aria-hidden
            data-ring
            data-cue="ring"
            className={cn(
              "pointer-events-none absolute inset-1 rounded-lg ring-2 ring-accent",
              cue.animate && "pk-content-in",
            )}
          />
        ) : null}
      </td>
      <td className="px-2 py-3">
        <a
          href={href.product(p.slug)}
          className="font-medium text-fg-strong after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          {p.name}
        </a>
        {p.justAdded || developer ? (
          <span className="block text-sm text-fg-muted">
            {p.justAdded ? (
              <>
                <span
                  data-cue="text"
                  className={cn(
                    "inline-block font-medium text-accent-fg",
                    cue.animate && "pk-pop-in",
                  )}
                >
                  Added just now
                </span>
                {developer ? " · " : null}
              </>
            ) : null}
            {developer}
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
      <td
        className={
          p.status.kind === "deviceLimit"
            ? "hidden px-2 py-3 text-sm font-medium text-danger wide:table-cell"
            : "hidden px-2 py-3 text-sm text-fg wide:table-cell"
        }
      >
        {p.kind === "entry"
          ? "–"
          : p.seats
            ? `${p.seats.inUse} of ${p.seats.limit}`
            : p.deviceCount}
      </td>
      <td className="relative hidden px-2 py-3 text-right desk:table-cell">
        <QuickActionButton
          product={p}
          action={action}
          lead={p.justAdded && isDownloadAction(action)}
          size="md"
          className="h-10"
        />
      </td>
      <td className="w-0 py-3 pr-4 desk:pr-5">
        <ChevronRight aria-hidden className="size-5 text-fg-muted" />
      </td>
    </tr>
  );
}
