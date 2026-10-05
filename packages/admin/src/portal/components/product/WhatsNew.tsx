import * as React from "react";
import { ChevronDown } from "lucide-react";
import type { LibraryProduct } from "../../model/library.js";
import { formatDay } from "../../model/library.js";
import { noteBlocks } from "../../model/product.js";
import { SectionCard } from "./Card.js";

/**
 * What's new (§4.20): the newest release's notes as plain text (never HTML), then earlier
 * versions, three at first with "Show all N".
 */
export function WhatsNew({
  product,
}: {
  product: LibraryProduct;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  const [latest, ...earlier] = product.releases;
  if (!latest) return null;
  const blocks = latest.notes ? noteBlocks(latest.notes) : [];
  const shown = all ? earlier : earlier.slice(0, 3);
  return (
    <SectionCard
      id="new"
      title={`What's new in ${latest.version}`}
      subtitle={[
        latest.title,
        latest.publishedAt ? formatDay(latest.publishedAt) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {blocks.length ? (
        <div className="space-y-3 text-[0.9375rem] text-fg">
          {blocks.map((b, i) =>
            b.kind === "ul" ? (
              <ul key={i} className="list-disc space-y-1.5 pl-5">
                {b.lines.map((l, j) => (
                  <li key={j}>{l}</li>
                ))}
              </ul>
            ) : (
              <p key={i}>{b.lines[0]}</p>
            ),
          )}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">
          This version has no release notes.
        </p>
      )}
      {earlier.length ? (
        <div className="mt-6">
          <div className="flex items-center justify-between border-b border-border pb-2">
            <h3 className="text-[0.9375rem] font-bold text-fg-strong">
              Earlier versions
            </h3>
            {earlier.length > 3 ? (
              <button
                type="button"
                aria-expanded={all}
                onClick={() => setAll((v) => !v)}
                className="inline-flex items-center gap-1 text-sm font-bold text-accent-fg hover:underline"
              >
                {all ? "Show fewer" : `Show all ${earlier.length}`}
                <ChevronDown
                  aria-hidden
                  className={all ? "size-4 rotate-180" : "size-4"}
                />
              </button>
            ) : null}
          </div>
          <ul className="divide-y divide-border">
            {shown.map((r) => (
              <li
                key={r.releaseId}
                className="flex items-center gap-6 py-3 text-sm"
              >
                <span className="w-20 font-mono text-fg-strong">
                  {r.version}
                </span>
                <span className="text-fg-muted">
                  {[r.publishedAt ? formatDay(r.publishedAt) : null, r.title]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  );
}
