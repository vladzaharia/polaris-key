import { AlertCircle } from "lucide-react";
import { deviceCount } from "../model/tileFacts.js";
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
import { t } from "../../lib/copy.js";

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
      <table className="w-full border-collapse text-start bigtext:max-desk:block">
        <caption className="sr-only">
          {t("locker.library.table.caption")}
        </caption>
        <thead className="hidden text-xs text-fg-muted desk:table-header-group">
          <tr className="border-b border-border">
            <th scope="col" className="py-3 ps-5 pe-2 font-normal">
              <span className="sr-only">{t("locker.library.table.icon")}</span>
            </th>
            <th scope="col" className="px-2 py-3 font-normal">
              {t("locker.library.table.product")}
            </th>
            <th scope="col" className="px-2 py-3 font-normal">
              {t("locker.library.table.status")}
            </th>
            <th
              scope="col"
              className="hidden px-2 py-3 font-normal wide:table-cell"
            >
              {t("locker.library.table.latest")}
            </th>
            <th
              scope="col"
              className="hidden px-2 py-3 font-normal wide:table-cell"
            >
              {t("account.devices")}
            </th>
            <th scope="col" className="px-2 py-3 text-end font-normal">
              {actionHeader}
            </th>
            <th scope="col" className="py-3 pe-5 font-normal">
              <span className="sr-only">{t("locker.library.table.open")}</span>
            </th>
          </tr>
        </thead>
        <tbody
          ref={bodyRef}
          className={cn(bodyClassName, "bigtext:max-desk:block")}
        >
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
      className="relative border-b border-border last:border-0 hover:bg-hover bigtext:max-desk:block bigtext:max-desk:px-3 bigtext:max-desk:py-3"
    >
      <td className="w-0 py-3 ps-4 pe-2 desk:ps-5 bigtext:max-desk:block bigtext:max-desk:w-auto bigtext:max-desk:p-0">
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
      <td className="px-2 py-3 bigtext:max-desk:mt-2 bigtext:max-desk:block bigtext:max-desk:p-0">
        <a
          href={href.product(p.slug)}
          dir="auto"
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
                  {t("locker.library.justAdded")}
                </span>
                {developer ? " · " : null}
              </>
            ) : null}
            {developer}
          </span>
        ) : null}
        <span className="mt-1 block desk:hidden">
          {p.status.kind === "deviceLimit" && p.seats ? (
            // As the grid says it: the device pill at its limit ("2/2 devices").
            <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-subtle px-2.5 py-0.5 text-xs font-medium text-warning">
              <AlertCircle aria-hidden className="size-3.5" />
              {deviceCount(p.seats.inUse, p.seats.limit)}
            </span>
          ) : (
            <ProductStatusPill status={p.status} />
          )}
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
            ? t("locker.library.seatsOf", {
                used: p.seats.inUse,
                limit: p.seats.limit,
              })
            : p.deviceCount}
      </td>
      <td className="relative hidden px-2 py-3 text-end desk:table-cell">
        <QuickActionButton
          product={p}
          action={action}
          lead={p.justAdded && isDownloadAction(action)}
          size="md"
          className="h-10"
        />
      </td>
      <td className="w-0 py-3 pe-4 desk:pe-5 bigtext:max-desk:hidden">
        <ChevronRight aria-hidden className="size-5 text-fg-muted" />
      </td>
    </tr>
  );
}
