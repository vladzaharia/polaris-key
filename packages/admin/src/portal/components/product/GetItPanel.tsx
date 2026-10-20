import * as React from "react";
import { ExternalLink, Info, Package } from "lucide-react";
import { Hash } from "../../../ui/Hash.js";
import { Button } from "../../../ui/Button.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { useProductDownloads } from "../../data.js";
import type { LibraryProduct, DeviceInHand } from "../../model/library.js";
import { formatDay, osName } from "../../model/library.js";
import {
  deviceNoun,
  getItFromDownloads,
  getItModel,
  type FileRowModel,
} from "../../model/product.js";
import {
  GET_IT_COPY as C,
  installOnThis,
  openOnComputer,
} from "../../copy/getIt.js";
import { PlatformGlyph, type PlatformKey } from "../Glyphs.js";
import { PILL_CLASS, StorePillList } from "../StorePills.js";
import { SectionCard } from "./Card.js";
import { DownloadButton } from "./DownloadButton.js";
import { InstallSourceList } from "./InstallSources.js";
import { t } from "../../../lib/copy.js";
import { platformInSentence } from "../../../lib/vocab/platforms.js";

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
    r.platform ? `${platformInSentence(r.platform)} ${r.title}` : r.title;
  const desktopFiles = model.groups.some(
    (g) =>
      g.rows.length > 0 &&
      (g.platform === "macos" ||
        g.platform === "windows" ||
        g.platform === "linux"),
  );
  // One table, each file once: the build for the device in hand first and tinted, then every
  // platform's files in the model's order (PX-28a; portal.license's Get it).
  const mine = new Set(model.recommended.map((r) => r.artifact.artifactId));
  const rows = [
    ...model.recommended,
    ...model.groups
      .flatMap((g) => g.rows)
      .filter((r) => !mine.has(r.artifact.artifactId)),
  ];
  const withSources = model.groups.filter((g) => g.sources.length > 0);
  return (
    <SectionCard
      id="get"
      title={t("getIt.heading")}
      aside={
        <p className="shrink-0 pt-1 text-right text-xs text-fg-muted">
          {latest.publishedAt
            ? t("getIt.latest", {
                version: latest.version,
                date: formatDay(latest.publishedAt),
              })
            : latest.version}
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
      ) : device.phone ? (
        <p className="mb-4 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-fg">
          {openOnComputer(product.name)}
        </p>
      ) : null}
      {rows.length ? (
        // The table scrolls inside its own labelled, focusable region, never the page.
        <div
          role="region"
          aria-label={t("getIt.table")}
          tabIndex={0}
          className="-mx-5 overflow-x-auto border-y border-border desk:-mx-6"
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
      {withSources.map((g) => (
        <section key={g.label} className="mt-5">
          <h3 className="text-md font-semibold text-fg-strong">{g.label}</h3>
          <InstallSourceList
            sources={g.sources}
            platform={g.platform}
            desktop={!device.phone}
            heading="h4"
          />
        </section>
      ))}
      {model.stores.length ? (
        <div className="mt-5 space-y-2">
          <h3
            id={`${product.slug}-also-yours-on`}
            className="text-md font-semibold text-fg-strong"
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
        {t("getIt.fresh")}
      </p>
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
      <th scope="row" className="px-5 py-3 text-left font-normal desk:px-6">
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
              {r.meta}
            </span>
          </span>
        </span>
      </th>
      <td className="hidden px-2 py-3 sm:table-cell">
        {r.artifact.sha256 ? (
          <Hash value={r.artifact.sha256} label="SHA-256" />
        ) : null}
      </td>
      <td className="px-5 py-3 text-right desk:px-6">
        {r.elsewhere ? (
          r.elsewhere.href ? (
            <Button asChild variant="quiet">
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
          />
        )}
      </td>
    </tr>
  );
}
