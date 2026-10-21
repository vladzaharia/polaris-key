/**
 * A branded, script-free page as a `Response` (`brandHtml.ts` is the shell, `securityHeaders.ts`
 * the policy), and the refusal copy the Worker's app-facing pages share: the text comes from the
 * kit-copy catalog (`core.codes.<code>.{title,message}`, generated from
 * `conformance/parity/copy.en.json`), so a page cannot drift from what an SDK shows.
 */

import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";
import { escapeHtml } from "../platform/html.js";
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import { renderBrandPage, type BrandPageOptions } from "./brandHtml.js";
import {
  cspImageOrigin,
  brandedHtmlSecurityHeaders,
} from "./securityHeaders.js";
import {
  PRESENTATION_HEADER_SLOTS,
  firstHostedImage,
  hostedImageUrl,
  hostedImages,
} from "./assets/hostedImages.js";
import { resolvePresentation } from "./presentation.js";
import type { ProductPublic } from "./products.js";
import type { ServiceHooks } from "./hooks.js";

/**
 * An app's icon as a page may draw it: the icon's origin when the policy can allow it
 * (`cspImageOrigin`), else the app without its icon. Whatever the policy would block is not drawn.
 */
export function pageApp(app: {
  name: string;
  iconUrl?: string | null;
  artUrl?: string | null;
}): {
  app: { name: string; iconUrl?: string | null; artUrl?: string | null };
  imgOrigin: string | null;
} {
  // One image origin per page (SIGN-IN.md §3.13): the icon's, else the art's; the other is
  // dropped when it is somewhere the policy does not allow.
  const originOf = (url: string | null | undefined): string | null => {
    if (!url) return null;
    try {
      return cspImageOrigin(new URL(url).origin);
    } catch {
      return null;
    }
  };
  const iconOrigin = originOf(app.iconUrl);
  const artOrigin = originOf(app.artUrl);
  const imgOrigin = iconOrigin ?? artOrigin;
  if (imgOrigin === null) return { app: { name: app.name }, imgOrigin: null };
  return {
    app: {
      name: app.name,
      ...(iconOrigin === imgOrigin ? { iconUrl: app.iconUrl } : {}),
      ...(artOrigin === imgOrigin ? { artUrl: app.artUrl } : {}),
    },
    imgOrigin,
  };
}

/** A branded page. `body` is TRUSTED markup: every value in it already escaped. */
export function brandPageResponse(
  status: number,
  page: Pick<BrandPageOptions, "title" | "heading" | "body" | "app" | "header">,
  cookies: readonly string[] = [],
): Response {
  let imgOrigin: string | null = null;
  if (page.app) {
    const shown = pageApp(page.app);
    imgOrigin = shown.imgOrigin;
    page = { ...page, app: shown.app };
  }
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
    { imgOrigin },
  );
  for (const c of cookies) headers.append("set-cookie", c);
  // No surface label beside the wordmark: sign-in pages carry no eyebrow (SIGN-IN.md §3.13).
  return new Response(renderBrandPage(page), { status, headers });
}

/** The catalog's title and message for a core error code, as plain text. */
export function codeCopy(code: string): { title: string; message: string } {
  const table = KIT_COPY_EN as Readonly<Record<string, string>>;
  const title = table[`core.codes.${code}.title`];
  const message = table[`core.codes.${code}.message`];
  if (title === undefined || message === undefined)
    throw new Error(`no kit copy for core code ${code}`);
  return { title, message };
}

/** The last line of a refusal: the page has no script, so there is no button to offer. */
export const CLOSE_PAGE = "You can close this page.";

/**
 * A refusal card for `code`, from the catalog, with the close-the-page line. `app` names the app
 * above the card; without it the page is the generic one (an unknown product).
 */
export function codeRefusalPage(
  status: number,
  code: string,
  app?: { name: string; iconUrl?: string | null },
): Response {
  const { title, message } = codeCopy(code);
  return brandPageResponse(status, {
    title,
    heading: title,
    body: `<p>${escapeHtml(message)}</p><p class="muted small">${CLOSE_PAGE}</p>`,
    ...(app ? { app } : {}),
  });
}

/** The app's display name and a small hosted icon (display data only, as discovery's). */
export async function appForPage(ctx: {
  product: Pick<ProductPublic, "slug" | "name" | "presentation">;
  env: Env;
  db: Db;
  hooks?: Pick<ServiceHooks, "delivery">;
}): Promise<{ name: string; iconUrl: string | null; artUrl: string | null }> {
  const p = await resolvePresentation({
    product: ctx.product,
    env: ctx.env,
    db: ctx.db,
    hooks: ctx.hooks ?? { delivery: () => null },
  });
  const icon = p?.icon;
  let iconUrl: string | null = null;
  if (icon) {
    const sizes = [...icon.sizes].sort((a, b) => a.w - b.w);
    const pick = sizes.find((s) => s.w >= 96) ?? sizes[sizes.length - 1];
    iconUrl =
      pick && icon.url
        ? icon.url.replace("{w}", String(pick.w))
        : icon.original;
  }
  // The passport's art: the product's hosted header (16:10 at 280 px, drawn at 2x), if any.
  const header = firstHostedImage(
    await hostedImages(
      ctx.env,
      ctx.db,
      ctx.product.slug,
      PRESENTATION_HEADER_SLOTS,
    ).catch(() => new Map()),
    PRESENTATION_HEADER_SLOTS,
  );
  const artUrl = header
    ? hostedImageUrl(ctx.env, ctx.product.slug, header, 640)
    : null;
  return { name: p?.name ?? ctx.product.name, iconUrl, artUrl };
}
