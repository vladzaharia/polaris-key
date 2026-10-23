/**
 * Presentation's base rows (A-27.12; products.settings-presentation): the Name, Accent and
 * Description every storefront's listing starts from. "Used by every storefront's listing unless it
 * sets its own": the listing's own value wins for the name and description; the accent is the
 * product's (HA-12 puts it before the listing's tint). Each row says where its value comes from.
 *
 *   - Name: the product's name (`.pkey/product`).
 *   - Accent: light and dark swatches from `presentation` in `.pkey/product`, source "Manifest".
 *   - Description: the listing's default-locale description and its source, when Distribution is on.
 *
 * Listing text is data: shown escaped, never as HTML.
 */

import { reads } from "../../../data/reads.js";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../../ui/Button.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { useProduct, useProductServices } from "../../../data/hooks.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { useListing } from "../../storefronts/data.js";
import { fieldSourceOf } from "./listing/ListingEditor.js";
import { sourceLabel } from "./listing/FieldSource.js";

const HEX = /^#[0-9a-fA-F]{6}$/;

function Swatch({
  label,
  hex,
}: {
  label: string;
  hex: string | null;
}): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        aria-hidden="true"
        data-swatch={label}
        className="inline-block size-5 rounded border border-border"
        style={hex ? { backgroundColor: hex } : undefined}
      />
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-xs text-fg">{hex ?? "Not set"}</span>
    </span>
  );
}

const asHex = (v: unknown): string | null =>
  typeof v === "string" && HEX.test(v) ? v.toLowerCase() : null;

export function PresentationBaseRows({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  const product = useProduct(slug);
  const services = useProductServices(slug);
  const listingOn = !services || services.distribution?.enabled !== false;
  const listing = useListing(slug);
  const area = "general";
  const settings = useQuery(reads.productSettings(slug, area));
  const presentation = settings.data?.settings.find(
    (s) => s.key === "core.presentation",
  )?.value as { accent?: unknown; accentDark?: unknown } | null | undefined;
  const accent = asHex(presentation?.accent);
  const accentDark = asHex(presentation?.accentDark);
  const link = (
    <Link
      to={r.listing(slug)}
      className="text-sm text-accent-fg underline-offset-4 hover:underline"
    >
      Edit listing
    </Link>
  );
  const manifest = (
    <StatusPill tone="neutral" icon={false} size="sm">
      Manifest
    </StatusPill>
  );

  const description = (() => {
    if (!listingOn)
      return <span className="text-sm text-fg-muted">Distribution is off</span>;
    if (listing.isPending) return <Skeleton className="h-5 w-48" />;
    if (listing.isError)
      return (
        <span className="flex items-center gap-2 text-sm text-danger">
          Could not load the listing.
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void listing.refetch()}
          >
            Retry
          </Button>
        </span>
      );
    const locale = listing.data.listing?.app.defaultLocale ?? "en-US";
    const text = listing.data.locales.find(
      (l) => l.locale === locale,
    )?.description;
    const src = fieldSourceOf(listing.data, locale, "description").source;
    return text ? (
      <span className="flex max-w-md flex-col items-end gap-1 text-end">
        <span className="line-clamp-3 whitespace-pre-wrap text-sm text-fg">
          {text}
        </span>
        <StatusPill tone="neutral" icon={false} size="sm">
          {sourceLabel(src ?? "admin")}
        </StatusPill>
      </span>
    ) : (
      <span className="text-sm text-fg-muted">Not set</span>
    );
  })();

  return (
    <SettingsSection
      id="presentation-base"
      title="Name, accent and description"
      description="Used by every storefront's listing unless it sets its own."
    >
      <SettingsRow label="Name" help="The product's name in .pkey/product.">
        <span className="flex flex-col items-end gap-1">
          <span className="text-sm text-fg">{product.data?.name ?? slug}</span>
          {manifest}
        </span>
      </SettingsRow>
      <SettingsRow
        label="Accent"
        help={
          accent || accentDark
            ? undefined
            : "Set presentation in .pkey/product."
        }
      >
        <span className="flex flex-col items-end gap-1">
          <Swatch label="Light" hex={accent} />
          <Swatch label="Dark" hex={accentDark} />
          {accent || accentDark ? manifest : null}
        </span>
      </SettingsRow>
      <SettingsRow label="Description" help="The default locale's text.">
        {description}
      </SettingsRow>
      <SettingsRow
        label="Store listing"
        help="Its text, images and fit for each storefront."
      >
        {link}
      </SettingsRow>
    </SettingsSection>
  );
}
