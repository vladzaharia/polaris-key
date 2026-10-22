import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Expand } from "../../../ui/motion/index.js";
import type { LibraryProduct } from "../../model/library.js";
import { formatDay } from "../../model/library.js";
import { releaseNotes } from "../../model/markdown.js";
import { Markdown } from "../Markdown.js";
import { SectionCard } from "./Card.js";
import { t } from "../../../lib/copy.js";

/**
 * What's new (§4.20): the newest release's notes, then earlier versions, three at first with
 * "Show all N".
 *
 * The notes are Markdown (owner polish 2026-10-07): drawn formatted from a parsed tree, never as
 * HTML (`model/markdown.ts`, `Markdown.tsx`), with only safe links. A short summary shows at once,
 * the first paragraph or list cut to three lines or items, and **Show full notes** opens the rest
 * in place below it with the expand pattern (`Expand`; at once under reduced motion, to the same
 * end state). The button stays where focus is, so opening or closing never loses it.
 */
export function WhatsNew({
  product,
}: {
  product: LibraryProduct;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  const [full, setFull] = React.useState(false);
  const restId = React.useId();
  const [latest, ...earlier] = product.releases;
  const notes = React.useMemo(
    () => (latest?.notes ? releaseNotes(latest.notes) : null),
    [latest?.notes],
  );
  if (!latest) return null;
  const shown = all ? earlier : earlier.slice(0, 3);
  return (
    <SectionCard
      id="new"
      title={t("releaseNotes.title", { product: latest.version })}
    >
      {notes && notes.summary.length ? (
        <div data-notes="" className="text-md text-fg">
          <div className="space-y-3">
            <Markdown blocks={notes.summary} />
          </div>
          {notes.rest.length ? (
            <>
              {/* -mx-1/px-1: room for a link's focus ring inside the region's clip. */}
              <Expand open={full} id={restId} className="-mx-1">
                <div data-notes-rest="" className="space-y-3 px-1 pt-3">
                  <Markdown blocks={notes.rest} />
                </div>
              </Expand>
              <button
                type="button"
                aria-expanded={full}
                aria-controls={restId}
                onClick={() => setFull((v) => !v)}
                className="mt-3 inline-flex min-h-6 items-center gap-1 pointer-coarse:min-h-11 text-sm font-medium text-accent-fg underline decoration-2 underline-offset-4 hover:text-fg-strong"
              >
                {full ? t("locker.notes.less") : t("locker.notes.full")}
                <ChevronDown
                  aria-hidden
                  className={full ? "size-4 rotate-180" : "size-4"}
                />
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{t("locker.notes.none")}</p>
      )}
      {earlier.length ? (
        <div className="mt-6">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h3 className="text-md font-semibold text-fg-strong">
              {t("locker.notes.earlier")}
            </h3>
            {earlier.length > 3 ? (
              <button
                type="button"
                aria-expanded={all}
                onClick={() => setAll((v) => !v)}
                className="inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline"
              >
                {all
                  ? t("locker.notes.fewer")
                  : t("locker.packages.showAll", { count: earlier.length })}
                <ChevronDown
                  aria-hidden
                  className={all ? "size-4 rotate-180" : "size-4"}
                />
              </button>
            ) : (
              <span className="text-sm text-fg-muted">
                {t("locker.notes.released")}
              </span>
            )}
          </div>
          <ul className="divide-y divide-border">
            {shown.map((r) => (
              <li
                key={r.releaseId}
                className="flex items-center justify-between gap-6 py-3 text-sm"
              >
                <span className="text-fg-strong">{r.version}</span>
                <span className="text-fg-muted">
                  {r.publishedAt ? formatDay(r.publishedAt) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}
