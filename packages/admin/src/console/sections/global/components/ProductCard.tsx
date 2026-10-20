import * as React from "react";
import type { AttentionItemDto, ProductDetail } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import {
  cardFeatures,
  featuresSentence,
  pillLabel,
  worstTone,
} from "../model/home.js";

/**
 * The cover (Cards view only, from `sm`): the product's hosted header art, else its icon on the
 * section-neutral subtle surface. Never a generated gradient, never read from canvas pixels. The
 * box is 72 px tall before the image arrives, so nothing shifts when it loads.
 */
function Cover({
  product: p,
  name,
}: {
  product: ProductDetail;
  name: string;
}): React.ReactElement {
  const header = p.presentation?.header ?? null;
  return (
    <div
      aria-hidden
      data-cover={header ? "art" : "flat"}
      className="grid h-[72px] shrink-0 place-items-center overflow-hidden rounded-t-lg border-b border-border bg-surface-sunken max-sm:hidden"
    >
      {header ? (
        <img
          src={header.url}
          alt=""
          loading="lazy"
          decoding="async"
          width={400}
          height={72}
          className="h-full w-full object-cover"
        />
      ) : (
        <ProductLogo name={name} presentation={p.presentation} size={32} />
      )}
    </div>
  );
}

/**
 * One product on Home (ST-36's card, ST-44's cover). The header holds the logo, the name (the
 * card's one link: its hit area stretches over the card, `::after`) and the slug, and one pill
 * only when something needs attention (the one issue named, or "N need attention"). Below it, one
 * row of glyphs, one per feature the product runs in canonical order (not one per service), each
 * named and linking to the feature's landing page as a sibling above the stretched name link; a
 * dot sits on the feature with the problem. No facts, no footer, no healthy pill.
 *
 * Under `sm` the card is one line: the name, then one pip per feature in the feature's accent,
 * the pips named together as an image (the issue included in the name).
 */
export function ProductCard({
  product: p,
  attention,
  cover = true,
}: {
  product: ProductDetail;
  attention: AttentionItemDto[];
  cover?: boolean;
}): React.ReactElement {
  const features = cardFeatures(p, attention);
  const name = p.name || p.slug;
  const sentence = featuresSentence(features);
  return (
    <article
      aria-label={name}
      className={cn(
        "relative flex w-full min-w-0 flex-col rounded-lg border border-border bg-surface-raised hover:border-border-strong light:shadow-elevation-1 has-[a[data-card-link]:focus-visible]:ring-2 has-[a[data-card-link]:focus-visible]:ring-focus has-[a[data-card-link]:focus-visible]:ring-offset-2 has-[a[data-card-link]:focus-visible]:ring-offset-surface-page max-sm:flex-row max-sm:items-center",
      )}
    >
      {cover ? <Cover product={p} name={name} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 max-sm:flex-row max-sm:items-center max-sm:py-3">
        <div
          data-card-header=""
          className="flex min-w-0 items-start gap-3 max-sm:flex-1 max-sm:items-center"
        >
          <ProductLogo
            name={name}
            presentation={p.presentation}
            size={40}
            className="max-sm:hidden"
          />
          <div className="min-w-0 flex-1">
            <h3
              className="line-clamp-2 break-words text-base font-semibold text-fg-strong max-sm:line-clamp-1"
              title={name}
            >
              <Link
                to={r.overview(p.slug)}
                data-card-link=""
                className="underline-offset-4 outline-hidden after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:underline focus-visible:ring-0 focus-visible:ring-offset-0"
              >
                {name}
              </Link>
            </h3>
            <p
              className="truncate font-mono text-xs text-fg-muted max-sm:hidden"
              title={p.slug}
            >
              {p.slug}
            </p>
          </div>
          {attention.length > 0 ? (
            <StatusPill
              tone={worstTone(attention)}
              size="sm"
              className="max-sm:hidden"
            >
              {pillLabel(attention)}
            </StatusPill>
          ) : null}
        </div>
        {features.length === 0 ? (
          <p className="mt-auto border-t border-border pt-3 text-sm text-fg-muted max-sm:mt-0 max-sm:border-0 max-sm:pt-0">
            No features
          </p>
        ) : (
          <>
            <div className="mt-auto border-t border-border pt-3 max-sm:hidden">
              <ul
                aria-label="Features"
                data-feature-icons=""
                className="flex flex-wrap items-center gap-1.5"
              >
                {features.map((f) => (
                  <li key={f.feature.id}>
                    <Link
                      to={f.href}
                      data-feature-link={f.feature.id}
                      aria-label={f.name}
                      title={f.name}
                      className="relative z-[1] grid size-8 place-items-center rounded-md border border-border hover:bg-surface-sunken"
                    >
                      <ServiceGlyph id={f.feature.accent} />
                      {f.issues.length > 0 ? (
                        <span
                          aria-hidden
                          data-issue-dot={worstTone(f.issues)}
                          className={cn(
                            "absolute right-0.5 top-0.5 size-2 rounded-full ring-2 ring-surface-raised",
                            worstTone(f.issues) === "danger"
                              ? "bg-danger"
                              : "bg-warning",
                          )}
                        />
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <span
              role="img"
              aria-label={sentence}
              title={sentence}
              data-feature-pips=""
              className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:hidden"
            >
              {features.map((f) => (
                <span
                  key={f.feature.id}
                  data-service={f.feature.accent}
                  data-pip={f.feature.id}
                  className="size-2.5 rounded-full bg-accent"
                />
              ))}
            </span>
          </>
        )}
      </div>
    </article>
  );
}
