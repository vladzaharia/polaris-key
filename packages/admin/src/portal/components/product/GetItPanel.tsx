import * as React from "react";
import { ExternalLink, Info, Package } from "lucide-react";
import { Hash } from "../../../ui/Hash.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { useProductDownloads } from "../../data.js";
import type { LibraryProduct, DeviceInHand } from "../../model/library.js";
import { formatDay, osName } from "../../model/library.js";
import {
  getItFromDownloads,
  getItModel,
  recommendedLabel,
  type FileRowModel,
} from "../../model/product.js";
import {
  GET_IT_COPY as C,
  installOnThis,
  openOnComputer,
} from "../../copy/getIt.js";
import { PLATFORM_NAME, PlatformGlyph } from "../Glyphs.js";
import { PILL_CLASS, StorePillList } from "../StorePills.js";
import { SectionCard } from "./Card.js";
import { DownloadButton } from "./DownloadButton.js";
import { InstallSourceList } from "./InstallSources.js";

/**
 * Get it, first cut (§4.20, PX-04): the build recommended for the device in hand (honest: a
 * Universal build is named as such; two Mac builds are both offered, Apple silicon first), then
 * All platforms grouped by OS and Extras, each file with its middle-truncated SHA-256 and every
 * file the license doesn't cover marked **Not included** with the reason as text.
 *
 * The data is the per-product downloads view (PX-W2: the Worker's own picks, reasons and store
 * links) when this Worker has it, else `GET /api/releases`. Change platform and the phone
 * actions come with PX-09.
 *
 * `device` is the product page's one OS source (`resolveDevice`, §0.6 P3), the value the header's
 * action used too: the recommendation's label and its build name the same OS. A file this site
 * doesn't host says where to get it ("Get it from Steam"), never "Not included".
 *
 * P0-48: every platform lists its install sources after its files ("Other ways to install":
 * Homebrew under macOS, AltStore under iPhone and iPad), the device's own OS first, and "Also
 * yours on" is the stores alone. On a phone that has a store or a source of its own, the panel
 * leads with them ("Install on this iPhone") instead of sending the person to a computer.
 */
export function GetItPanel({
  product,
  device,
}: {
  product: LibraryProduct;
  device: DeviceInHand;
}): React.ReactElement | null {
  const downloads = useProductDownloads(product.slug, true);
  if (downloads.isPending)
    return (
      <SectionCard id="get" title={`Get ${product.name}`}>
        <Skeleton className="h-40 w-full" aria-busy />
      </SectionCard>
    );
  const who = {
    developer: product.presentation.developer,
    website: product.presentation.website,
  };
  const model =
    (downloads.data ? getItFromDownloads(downloads.data, device, who) : null) ??
    getItModel(
      product.releases,
      device,
      product.licenses.some((l) => l.usable),
      { ...who, stores: product.stores },
    );
  if (!model) return null;
  const { latest, here } = model;
  const describe = (r: FileRowModel) =>
    r.platform ? `${PLATFORM_NAME[r.platform]} ${r.title}` : r.title;
  const desktopFiles = model.groups.some(
    (g) =>
      g.rows.length > 0 &&
      (g.platform === "macos" ||
        g.platform === "windows" ||
        g.platform === "linux"),
  );
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
          license. Your license covers {model.release.version}, below.
        </p>
      ) : null}
      {here ? (
        <div className="mb-5 space-y-3 rounded-xl border border-border bg-accent-subtle p-4 desk:p-5">
          <p className="text-sm text-fg-muted">{installOnThis(here.os)}</p>
          <ul
            aria-label={installOnThis(here.os)}
            className="flex flex-wrap gap-2"
          >
            {here.stores.map((s) => (
              <li key={s.id}>
                <a
                  href={s.url!}
                  target="_blank"
                  rel="noreferrer"
                  className={PILL_CLASS}
                >
                  {s.label}
                  <ExternalLink aria-hidden className="size-4 text-accent-fg" />
                  <span className="sr-only">{C["getIt.newTab"]}</span>
                </a>
              </li>
            ))}
            {here.sources.map((s) => (
              <li key={s.id}>
                {s.deepLink ? (
                  <a href={s.deepLink} className={PILL_CLASS}>
                    {s.label}
                  </a>
                ) : (
                  <a
                    href={s.url!}
                    target="_blank"
                    rel="noreferrer"
                    className={PILL_CLASS}
                  >
                    {s.label}
                    <ExternalLink
                      aria-hidden
                      className="size-4 text-accent-fg"
                    />
                    <span className="sr-only">{C["getIt.newTab"]}</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
          {desktopFiles ? (
            <p className="text-sm text-fg-muted">{C["getIt.otherFiles"]}</p>
          ) : null}
        </div>
      ) : device.phone ? (
        <p className="mb-4 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg">
          {openOnComputer(product.name)}
        </p>
      ) : model.os && model.recommended.length ? (
        // A size container: the column is narrow on tablets (main · side), so the build and its
        // Download sit side by side only when the box has 24rem, not from a viewport width.
        <div className="mb-5 space-y-3 rounded-xl border border-border bg-accent-subtle p-4 @container desk:p-5">
          <p className="text-sm text-fg-muted">{recommendedLabel(model.os)}</p>
          {model.recommended.map((r) => (
            <div
              key={r.artifact.artifactId}
              className="flex flex-col gap-3 @sm:flex-row @sm:items-center"
            >
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-page text-fg-strong">
                {r.platform ? (
                  <PlatformGlyph platform={r.platform} className="size-6" />
                ) : null}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-fg-strong">
                  {r.platform ? `${osName(r.platform)} · ` : ""}
                  {r.title}
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
                release={r.release}
                artifact={r.artifact}
                describe={describe(r)}
                lead
              />
            </div>
          ))}
        </div>
      ) : null}
      <h3 className="mb-2 text-md font-bold text-fg-strong">All platforms</h3>
      <div className="divide-y divide-border border-t border-border">
        {model.groups.map((g) => (
          <div key={g.label} className="py-2">
            <h4 className="py-2 text-xs font-bold text-fg-muted">{g.label}</h4>
            {g.rows.length ? (
              <ul className="divide-y divide-border">
                {g.rows.map((r) => (
                  <li
                    key={r.artifact.artifactId}
                    className="flex flex-wrap items-center gap-3 py-3"
                  >
                    <span className="inline-flex size-8 shrink-0 items-center justify-center text-fg-muted">
                      {r.platform ? (
                        <PlatformGlyph
                          platform={r.platform}
                          className="size-5"
                        />
                      ) : (
                        <Package aria-hidden className="size-5" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      {/* Wraps, never cut short (§4.20, like a device's name). */}
                      <p
                        data-platform-name=""
                        className="break-words font-bold text-fg-strong"
                      >
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
                    {r.elsewhere ? (
                      r.elsewhere.href ? (
                        <a
                          href={r.elsewhere.href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-10 items-center gap-2 rounded-md border border-border-strong px-3 text-sm font-bold text-fg-strong hover:bg-hover"
                        >
                          {r.elsewhere.label}
                          <ExternalLink aria-hidden className="size-4" />
                          <span className="sr-only">{C["getIt.newTab"]}</span>
                        </a>
                      ) : (
                        <span className="text-right text-sm font-bold text-fg-strong">
                          {r.elsewhere.label}
                        </span>
                      )
                    ) : r.notIncluded ? (
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
                        release={r.release}
                        artifact={r.artifact}
                        describe={describe(r)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            <InstallSourceList
              sources={g.sources}
              platform={g.platform}
              desktop={!device.phone}
            />
          </div>
        ))}
      </div>
      {model.stores.length ? (
        <div className="mt-5 space-y-2">
          <h3
            id={`${product.slug}-also-yours-on`}
            className="text-md font-bold text-fg-strong"
          >
            {C["getIt.alsoYoursOn"]}
          </h3>
          <StorePillList
            stores={model.stores}
            labelledBy={`${product.slug}-also-yours-on`}
          />
        </div>
      ) : null}
      <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="size-4 shrink-0" />
        Download links are made fresh when you click, so they never go stale.
      </p>
    </SectionCard>
  );
}
