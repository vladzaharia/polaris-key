import * as React from "react";
import { ExternalLink, Info, Package } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import type { PortalDownloads } from "../../api.js";
import { useProductDownloads } from "../../data.js";
import type { LibraryProduct, DeviceInHand } from "../../model/library.js";
import { formatDay, osName } from "../../model/library.js";
import {
  deviceNoun,
  getItFromDownloads,
  fileSource,
  getItModel,
  type FileRowModel,
} from "../../model/product.js";
import {
  GET_IT_COPY as C,
  installOnThis,
  openOnComputer,
} from "../../copy/getIt.js";
import { FileHash } from "./FileHash.js";
import { PlatformGlyph, type PlatformKey } from "../Glyphs.js";
import { PILL_CLASS, StorePillList } from "../StorePills.js";
import { SectionCard } from "./Card.js";
import { DownloadButton } from "./DownloadButton.js";
import { InstallSourceList } from "./InstallSources.js";
import { t } from "../../../lib/copy.js";
import { platformInSentence } from "../../../lib/vocab/platforms.js";

/**
 * What Get it shows, from the downloads view (else the releases): the model, its rows (an
 * inactive license's files left out), the install sources, the stores not already on the phone's
 * lead, and whether the card renders at all. The product page asks the same question for its
 * nav, so a section that is not drawn is not in the nav either.
 */
function getItView(
  product: LibraryProduct,
  device: DeviceInHand,
  data: PortalDownloads | null | undefined,
) {
  const who = {
    developer: product.presentation.developer,
    website: product.presentation.website,
  };
  const model =
    (data ? getItFromDownloads(data, device, who) : null) ??
    getItModel(
      product.releases,
      device,
      product.licenses.some((l) => l.usable),
      { ...who, stores: product.stores },
    );
  if (!model) return null;
  const mine = new Set(model.recommended.map((r) => r.artifact.artifactId));
  // A license that is not active says so once, in the License card: its files get no row here.
  const rows = [
    ...model.recommended,
    ...model.groups
      .flatMap((g) => g.rows)
      .filter((r) => !mine.has(r.artifact.artifactId)),
  ].filter((r) => !r.inactive);
  const withSources = model.groups.filter((g) => g.sources.length > 0);
  // The phone's lead already offers its own stores: "Also yours on" never repeats them.
  const leadIds = new Set(model.here?.stores.map((s) => s.id));
  const stores = model.stores.filter((s) => !leadIds.has(s.id));
  // A phone hands off to a computer only when a computer could download something.
  const filesElsewhere = model.groups.some((g) =>
    g.rows.some((r) => !r.inactive),
  );
  const render =
    rows.length > 0 ||
    withSources.length > 0 ||
    stores.length > 0 ||
    model.here !== null ||
    (device.phone && filesElsewhere);
  return { model, mine, rows, withSources, stores, render, filesElsewhere };
}

/** Whether the Get it card will be drawn: true while the downloads are still loading. */
export function useGetItShown(
  product: LibraryProduct,
  device: DeviceInHand,
): boolean {
  const downloads = useProductDownloads(product.slug, true);
  if (downloads.isPending) return true;
  return getItView(product, device, downloads.data)?.render ?? false;
}

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
      <SectionCard id="get" title={t("getIt.heading")}>
        <Skeleton className="h-40 w-full" aria-busy />
      </SectionCard>
    );
  const view = getItView(product, device, downloads.data);
  if (!view?.render) return null;
  const { model, mine, rows, withSources, stores, filesElsewhere } = view;
  const { latest, here } = model;
  // The accessible name says which file: its build and its file name.
  const describe = (r: FileRowModel) =>
    r.platform
      ? `${platformInSentence(r.platform)} ${r.title}, ${r.artifact.name}`
      : r.title;
  const desktopFiles = model.groups.some(
    (g) =>
      g.rows.length > 0 &&
      (g.platform === "macos" ||
        g.platform === "windows" ||
        g.platform === "linux"),
  );
  // The head names the release the rows are (the covered one, when the newest is not covered).
  const shown = model.newerNotCovered
    ? { version: model.release.version, publishedAt: model.release.publishedAt }
    : latest;
  return (
    <SectionCard
      id="get"
      title={t("getIt.heading")}
      aside={
        <p className="shrink-0 pt-1 text-right text-xs text-fg-muted">
          {shown.publishedAt
            ? t("getIt.latest", {
                version: shown.version,
                date: formatDay(shown.publishedAt),
              })
            : shown.version}
        </p>
      }
    >
      {model.newerNotCovered ? (
        <p className="mb-4 flex gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm text-fg">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
          {t("getIt.notCovered", {
            version: model.newerNotCovered.version,
            max: model.release.version,
          })}
        </p>
      ) : null}
      {here ? (
        <div className="mb-5 space-y-3 rounded-xl border border-border bg-surface-sunken p-4 desk:p-5">
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
                  <ExternalLink aria-hidden className="size-4 text-fg-muted" />
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
                      className="size-4 text-fg-muted"
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
      ) : device.phone && filesElsewhere ? (
        <p className="mb-4 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg">
          {openOnComputer(product.name)}
        </p>
      ) : null}
      {rows.length ? (
        // The table scrolls inside its own labelled, focusable region, never the page. `relative`
        // makes the region the containing block of the table's sr-only cells (`position: absolute`):
        // otherwise they sit past the region's clip and widen the page (WCAG 1.4.10).
        <div
          role="region"
          aria-label={t("getIt.table")}
          tabIndex={0}
          className="relative -mx-5 overflow-x-auto border-y border-border desk:-mx-6"
        >
          <table className="w-full min-w-[17rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("getIt.table")}</caption>
            <thead>
              <tr className="text-xs text-fg-muted">
                <th scope="col" className="px-5 py-2 font-medium desk:px-6">
                  {t("getIt.col.platform")}
                </th>
                <th
                  scope="col"
                  className="hidden px-2 py-2 font-medium sm:table-cell"
                >
                  {C["getIt.flow.sha256"]}
                </th>
                <th scope="col" className="px-5 py-2 desk:px-6">
                  <span className="sr-only">{t("getIt.col.action")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border border-t border-border">
              {rows.map((r) => (
                <FileRow
                  key={r.artifact.artifactId}
                  row={r}
                  mine={mine.has(r.artifact.artifactId) ? model.os : null}
                  product={product}
                  describe={describe(r)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {withSources.length ? (
        <section className="mt-5 space-y-3">
          <h3 className="text-md font-semibold text-fg-strong">
            {C["getIt.otherWays"]}
          </h3>
          {withSources.map((g) => (
            <div key={g.label}>
              <h4 className="text-xs font-semibold text-fg-muted">{g.label}</h4>
              <InstallSourceList
                sources={g.sources}
                platform={g.platform}
                desktop={!device.phone}
                heading={null}
              />
            </div>
          ))}
        </section>
      ) : null}
      {stores.length ? (
        <div className="mt-5 space-y-2">
          <h3
            id={`${product.slug}-also-yours-on`}
            className="text-md font-semibold text-fg-strong"
          >
            {C["getIt.alsoYoursOn"]}
          </h3>
          <StorePillList
            stores={stores}
            labelledBy={`${product.slug}-also-yours-on`}
          />
        </div>
      ) : null}
    </SectionCard>
  );
}

/** One file of the downloads table: its name over its facts, its checksum, its one action. */
function FileRow({
  row: r,
  mine,
  product,
  describe,
}: {
  row: FileRowModel;
  /** The OS this is the build for, when it is the one for the device in hand. */
  mine: PlatformKey | null;
  product: LibraryProduct;
  describe: string;
}): React.ReactElement {
  return (
    <tr className={mine ? "bg-surface-sunken" : undefined}>
      {/* The device's own build: tinted, with a strong edge, so it reads in dark too. */}
      <th
        scope="row"
        className={`border-l-4 px-4 py-3 text-left font-normal desk:px-5 ${mine ? "border-fg-strong" : "border-transparent"}`}
      >
        <span className="flex items-center gap-3">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-page text-fg-muted">
            {r.platform ? (
              <PlatformGlyph platform={r.platform} className="size-5" />
            ) : (
              <Package aria-hidden className="size-5" />
            )}
          </span>
          <span className="min-w-0">
            {/* Wraps, never cut short (§4.20, like a device's name). */}
            <span
              data-platform-name=""
              className="block break-words font-medium text-fg-strong"
            >
              {r.platform ? `${osName(r.platform)} · ${r.title}` : r.title}
            </span>
            <span className="block text-fg-muted">
              {mine
                ? `${t("getIt.forYour", { device: deviceNoun(mine) })} · `
                : ""}
              {/* A size never breaks across lines ("3.1 GB"). */}
              {fileSource(r.artifact)?.replace(
                /(\d) (?=[KMGT]?B\b)/,
                "$1\u00a0",
              )}
            </span>
          </span>
        </span>
      </th>
      <td className="hidden whitespace-nowrap px-2 py-3 sm:table-cell">
        {r.artifact.sha256 && !r.elsewhere && !r.notIncluded ? (
          <FileHash value={r.artifact.sha256} file={r.artifact.name} />
        ) : null}
      </td>
      <td className="px-5 py-3 text-right desk:px-6">
        {r.elsewhere ? (
          r.elsewhere.href ? (
            <Button
              asChild
              variant="quiet"
              className="min-h-11 whitespace-normal"
            >
              <a href={r.elsewhere.href} target="_blank" rel="noreferrer">
                {r.elsewhere.label}
                <ExternalLink aria-hidden />
                <span className="sr-only">{C["getIt.newTab"]}</span>
              </a>
            </Button>
          ) : (
            <span className="font-medium text-fg-strong">
              {r.elsewhere.label}
            </span>
          )
        ) : r.notIncluded ? (
          <span className="block">
            <span className="block font-medium text-fg-strong">
              {t("core.codes.not_entitled.title")}
            </span>
            <span className="block text-fg-muted">{r.notIncluded}</span>
          </span>
        ) : (
          <DownloadButton
            product={product.slug}
            productName={product.name}
            release={r.release}
            artifact={r.artifact}
            describe={describe}
            table
          />
        )}
      </td>
    </tr>
  );
}
