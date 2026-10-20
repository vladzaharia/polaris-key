import * as React from "react";
import type { AttentionItemDto, ProductDetail } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useCanOpenHref } from "../../../access/context.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import {
  cardFeatures,
  featuresSentence,
  pillLabel,
  worstTone,
} from "../model/home.js";

/**
 * The cover (Cards view only, from `sm`): the product's hosted header art, else a neutral band
 * one step lighter than the card: no second logo, never a generated gradient, never read from
 * canvas pixels. The box is 72 px tall before the image arrives, so nothing shifts when it loads.
 */
function Cover({ product: p }: { product: ProductDetail }): React.ReactElement {
  const header = p.presentation?.header ?? null;
  return (
    <div
      aria-hidden
      data-cover={header ? "art" : "flat"}
      className="h-[72px] shrink-0 overflow-hidden rounded-t-lg border-b border-border bg-hover max-sm:hidden"
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
      ) : null}
    </div>
  );
}

/**
 * One row of glyphs as a single tab stop: Left and Right (and Home, End) move between them, the
 * way a toolbar does, so a card costs one Tab however many features it runs.
 */
function useRoving(count: number): {
  index: number;
  onKeyDown: (e: React.KeyboardEvent<HTMLUListElement>) => void;
  setIndex: (i: number) => void;
} {
  const [index, setIndex] = React.useState(0);
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    const next =
      e.key === "ArrowRight"
        ? Math.min(index + 1, count - 1)
        : e.key === "ArrowLeft"
          ? Math.max(index - 1, 0)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? count - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setIndex(next);
    e.currentTarget
      .querySelectorAll<HTMLElement>("[data-glyph]")
      [next]?.focus();
  };
  return { index, onKeyDown, setIndex };
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
  // A glyph to a page the member's role cannot open is a plain glyph, never a link to a refusal.
  const canOpen = useCanOpenHref();
  const roving = useRoving(features.length);
  return (
    <article
      aria-label={name}
      className={cn(
        "relative flex w-full min-w-0 flex-col rounded-lg border border-border bg-surface-raised hover:border-border-strong light:shadow-elevation-1 has-[a[data-card-link]:focus-visible]:ring-2 has-[a[data-card-link]:focus-visible]:ring-focus has-[a[data-card-link]:focus-visible]:ring-offset-2 has-[a[data-card-link]:focus-visible]:ring-offset-surface-page forced-colors:has-[a[data-card-link]:focus-visible]:outline-2 forced-colors:has-[a[data-card-link]:focus-visible]:outline-offset-2",
      )}
    >
      {cover ? <Cover product={p} /> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 max-sm:py-3">
        <div data-card-header="" className="flex min-w-0 items-start gap-3">
          <ProductLogo
            name={name}
            presentation={p.presentation}
            size={40}
            className="max-sm:hidden"
          />
          <ProductLogo
            name={name}
            presentation={p.presentation}
            size={32}
            className="sm:hidden"
          />
          <div className="min-w-0 flex-1">
            <h3
              className="line-clamp-2 break-words text-base font-semibold text-fg-strong"
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
            <div className="flex min-w-0 items-center gap-2">
              <p
                className="min-w-0 truncate font-mono text-xs text-fg-muted"
                title={p.slug}
              >
                {p.slug}
              </p>
              {/* Phone: one pip per feature beside the slug, named together with the issue. */}
              {features.length > 0 ? (
                <span
                  role="img"
                  aria-label={sentence}
                  title={sentence}
                  data-feature-pips=""
                  className="flex shrink-0 items-center gap-1 sm:hidden"
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
              ) : null}
            </div>
          </div>
          {attention.length > 0 ? (
            <StatusPill tone={worstTone(attention)} size="sm">
              {pillLabel(attention)}
            </StatusPill>
          ) : null}
        </div>
        {features.length === 0 ? (
          <p className="mt-auto border-t border-border pt-3 text-sm text-fg-muted max-sm:hidden">
            No features
          </p>
        ) : (
          <div className="mt-auto border-t border-border pt-3 max-sm:hidden">
            <ul
              aria-label="Features"
              data-feature-icons=""
              onKeyDown={roving.onKeyDown}
              className="flex flex-wrap items-center gap-1.5"
            >
              {features.map((f, i) => {
                const common = {
                  "data-glyph": "",
                  "data-feature-link": f.feature.id,
                  "aria-label": f.name,
                  title: f.name,
                  tabIndex: i === roving.index ? 0 : -1,
                  onFocus: () => roving.setIndex(i),
                  className:
                    "relative z-[1] grid size-8 place-items-center rounded-md border border-border",
                };
                const inner = (
                  <>
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
                  </>
                );
                return (
                  <li key={f.feature.id}>
                    {canOpen(f.href) ? (
                      <Link
                        to={f.href}
                        {...common}
                        className={cn(
                          common.className,
                          "hover:bg-surface-sunken",
                        )}
                      >
                        {inner}
                      </Link>
                    ) : (
                      <span role="img" {...common}>
                        {inner}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </article>
  );
}
