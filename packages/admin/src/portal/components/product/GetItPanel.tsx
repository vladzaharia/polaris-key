import * as React from "react";
import { Info, Package } from "lucide-react";
import { Hash } from "../../../ui/Hash.js";
import type { LibraryProduct, DeviceInHand } from "../../model/library.js";
import { formatDay, osName } from "../../model/library.js";
import { getItModel, type FileRowModel } from "../../model/product.js";
import { PLATFORM_NAME, PlatformGlyph } from "../Glyphs.js";
import { SectionCard } from "./Card.js";
import { DownloadButton } from "./DownloadButton.js";

/**
 * Get it, first cut (§4.20, PX-04): the build recommended for the device in hand (honest: a
 * Universal build is named as such; two Mac builds are both offered, Apple silicon first), then
 * All platforms grouped by OS and Extras, each file with its middle-truncated SHA-256 and every
 * file the license doesn't cover marked **Not included** with the reason as text. Change
 * platform, store links and phone actions come with PX-09.
 */
export function GetItPanel({
  product,
  device,
}: {
  product: LibraryProduct;
  device: DeviceInHand;
}): React.ReactElement | null {
  const model = getItModel(product.releases, device);
  if (!model) return null;
  const { release } = model;
  const latest = product.releases[0]!;
  const describe = (r: FileRowModel) =>
    r.platform ? `${PLATFORM_NAME[r.platform]} ${r.title}` : r.title;
  return (
    <SectionCard
      id="get"
      title={`Get ${product.name}`}
      subtitle={`Latest: ${latest.version}${latest.publishedAt ? `, released ${formatDay(latest.publishedAt)}` : ""}`}
    >
      {model.newerNotCovered ? (
        <p className="mb-4 flex gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-fg">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
          Version {model.newerNotCovered.version} isn't included in your
          license. Your license covers {release.version}, below.
        </p>
      ) : null}
      {device.phone ? (
        <p className="mb-4 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg">
          Open this page on your computer to download {product.name}.
        </p>
      ) : model.recommended.length ? (
        <div className="mb-5 space-y-3 rounded-xl border border-border bg-accent-subtle p-4 desk:p-5">
          <p className="text-sm text-fg-muted">
            Recommended for this {device.os === "macos" ? "Mac" : "computer"}
          </p>
          {model.recommended.map((r) => (
            <div
              key={r.artifact.artifactId}
              className="flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-page text-fg-strong">
                {r.platform ? (
                  <PlatformGlyph platform={r.platform} className="size-6" />
                ) : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-fg-strong">
                  {device.os ? osName(device.os) : ""} · {r.title}
                </p>
                <p className="text-sm text-fg-muted">
                  {r.title === "Universal" && r.platform === "macos"
                    ? "Runs on Apple silicon and Intel · "
                    : ""}
                  {r.meta}
                </p>
              </div>
              <DownloadButton
                product={product.slug}
                productName={product.name}
                release={release}
                artifact={r.artifact}
                describe={describe(r)}
                lead
              />
            </div>
          ))}
        </div>
      ) : null}
      <h3 className="mb-2 text-[0.9375rem] font-bold text-fg-strong">
        All platforms
      </h3>
      <div className="divide-y divide-border border-t border-border">
        {model.groups.map((g) => (
          <div key={g.label} className="py-2">
            <h4 className="py-2 text-xs font-bold text-fg-muted">{g.label}</h4>
            <ul className="divide-y divide-border">
              {g.rows.map((r) => (
                <li
                  key={r.artifact.artifactId}
                  className="flex flex-wrap items-center gap-3 py-3"
                >
                  <span className="inline-flex size-8 shrink-0 items-center justify-center text-fg-muted">
                    {r.platform ? (
                      <PlatformGlyph platform={r.platform} className="size-5" />
                    ) : (
                      <Package aria-hidden className="size-5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-fg-strong">
                      {r.title}
                    </p>
                    <p className="text-sm text-fg-muted">{r.meta}</p>
                  </div>
                  {r.artifact.sha256 ? (
                    <Hash
                      value={r.artifact.sha256}
                      label="SHA-256"
                      className="hidden sm:inline-flex"
                    />
                  ) : null}
                  {r.notIncluded ? (
                    <span className="text-right text-sm">
                      <span className="block font-bold text-fg-strong">
                        Not included
                      </span>
                      <span className="block text-fg-muted">
                        {r.notIncluded}
                      </span>
                    </span>
                  ) : (
                    <DownloadButton
                      product={product.slug}
                      productName={product.name}
                      release={release}
                      artifact={r.artifact}
                      describe={describe(r)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="size-4 shrink-0" />
        Download links are made fresh when you click, so they never go stale.
      </p>
    </SectionCard>
  );
}
