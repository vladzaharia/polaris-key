import * as React from "react";
import { ErrorState } from "../../ui/ErrorState.js";
import { Info, Monitor } from "lucide-react";
import type {
  PortalAccount,
  PortalDownloads,
  PortalProduct,
  PortalStoreLink,
} from "../api.js";
import {
  FocusedFlow,
  TaskFrame,
  TaskFrameSkeleton,
} from "../components/FocusedFlow.js";
import { type PlatformKey } from "../../ui/Glyphs.js";
import { platformInSentence } from "../../lib/vocab/platforms.js";
import { StorePills } from "../components/StorePills.js";
import { BuildDetails } from "../components/product/BuildDetails.js";
import { DownloadButton } from "../components/product/DownloadButton.js";
import { EmailDownloadButton } from "../components/product/EmailDownloadButton.js";
import { InstallSourceList } from "../components/product/InstallSources.js";
import { OtherBuilds, otherBuilds } from "../components/product/OtherBuilds.js";
import {
  GET_IT_COPY as C,
  downloadFor,
  downloadName,
  installHint,
  lastCovered,
} from "../copy/getIt.js";
import { useProduct, useProductDownloads } from "../data.js";
import { isNotFound } from "../errors.js";
import {
  detectDevice,
  formatDay,
  normalisePlatform,
  osName,
  presentationFrom,
} from "../model/library.js";
import {
  fileFormat,
  fileSource,
  getItFromDownloads,
  type FileRowModel,
} from "../model/product.js";
import { allowedReturn } from "../model/returnUrl.js";
import { href, useDocumentTitle } from "../router.js";
import { flowBack } from "./FreeDevicePage.js";
import { NotFoundProduct } from "./NotFoundProduct.js";
import { t } from "../../lib/copy.js";

/** The desktop platforms, in the order a phone with no build of its own is shown one. */
const DESKTOP: readonly PlatformKey[] = ["macos", "windows", "linux"];

/**
 * Whether the account can download something for `k`: a covered file in the newest release, or
 * the Worker's recommendation (the last covered release, when the newest isn't).
 */
function hasCovered(d: PortalDownloads, k: PlatformKey): boolean {
  return d.platforms.some(
    (p) =>
      normalisePlatform(p.platform) === k &&
      (p.recommended != null || p.files.some((f) => f.canDownload)),
  );
}

/** The live stores with a page that carry `k`. */
function liveStoresFor(d: PortalDownloads, k: PlatformKey): PortalStoreLink[] {
  return d.stores.filter(
    (s) =>
      s.live && s.url && s.platforms.some((p) => normalisePlatform(p) === k),
  );
}

/**
 * The platform the page is about. `?platform=` when it names one; else, on a computer, the OS in
 * hand; else the Worker's guess. A phone with no `?platform=` is shown its own OS when there is a
 * covered file or a live store for it, else the first desktop platform (macOS, Windows, Linux)
 * with a covered file, which it can email itself, else the Worker's guess.
 */
export function flowPlatform(
  param: string | null,
  d: PortalDownloads,
): PlatformKey | null {
  const asked = normalisePlatform(param);
  if (asked) return asked;
  const device = detectDevice();
  const guess = normalisePlatform(d.detected.platform);
  if (!device.phone) return device.os ?? guess;
  const own = device.os;
  if (own && (hasCovered(d, own) || liveStoresFor(d, own).length > 0))
    return own;
  return DESKTOP.find((k) => hasCovered(d, k)) ?? guess;
}

/**
 * The downloads view with each platform's files as this page offers them. The Worker lists a
 * platform's files from its newest release, covered or not. When the last release the license
 * covers is an older one (`recommended.latest` is false) its files are only in the
 * recommendation, so they stand for the platform: the page leads with a build the license covers
 * instead of the newest one it doesn't.
 */
function offered(d: PortalDownloads): PortalDownloads {
  return {
    ...d,
    platforms: d.platforms.map((p) => {
      const rec = p.recommended;
      return rec && !p.files.some((f) => f.releaseId === rec.releaseId)
        ? { ...p, files: rec.files }
        : p;
    }),
  };
}

/**
 * One download, the focused flow (PORTAL.md §3.3, §3.4, §4.25, PX-10, PX-29):
 * `#/p/<product>/download?platform=`, the target of "Email me the download" and an app's
 * "Download update". It names the build before the action (version in the title, then OS,
 * architecture, file type and size), offers it with the one primary, and keeps the facts to
 * check it (channel, SHA-256) and the other platforms and architectures one disclosure away; the
 * platform's stores and its other ways to install (Homebrew, Scoop, AltStore, F-Droid…, P0-48)
 * follow. A platform with nothing the license covers says why in words and offers no action.
 * `?return=` is followed only to an origin or scheme the product declares.
 */
export function DownloadFlowPage({
  account,
  product: slug,
  params,
}: {
  account: PortalAccount;
  product: string;
  params: URLSearchParams;
}): React.ReactElement {
  const product = useProduct(slug);
  const downloads = useProductDownloads(slug, product.isSuccess);
  const p = product.data;
  useDocumentTitle(
    p
      ? t("locker.download.title", { product: p.name })
      : product.isPending
        ? null
        : t("boot.consent.download"),
  );
  const returnUrl = p ? allowedReturn(params.get("return"), p.returnTo) : null;
  const back = flowBack(
    slug,
    p?.name ?? t("locker.freeDevice.theProduct"),
    returnUrl,
  );
  const pending =
    product.isPending || (product.isSuccess && downloads.isPending);
  const error = product.error ?? downloads.error;
  return (
    <FocusedFlow back={back}>
      {pending ? (
        <TaskFrameSkeleton />
      ) : product.error && isNotFound(product.error) ? (
        <NotFoundProduct email={account.email} />
      ) : error || !p ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void product.refetch();
            void downloads.refetch();
          }}
          asPage
        />
      ) : (
        <DownloadBody
          product={p}
          downloads={downloads.data ?? null}
          params={params}
        />
      )}
    </FocusedFlow>
  );
}

function DownloadBody({
  product,
  downloads,
  params,
}: {
  product: PortalProduct;
  downloads: PortalDownloads | null;
  params: URLSearchParams;
}): React.ReactElement {
  const pres = presentationFrom(product);
  const device = detectDevice();
  const model = downloads
    ? getItFromDownloads(offered(downloads), device, {
        developer: pres.developer,
        website: pres.website,
      })
    : null;
  const platform = downloads
    ? flowPlatform(params.get("platform"), downloads)
    : null;

  // A platform's files: the recommended release's when the Worker recommends one (an older
  // release's files are history), else all of them, each with the reason it can't be downloaded.
  const rowsOf = (k: PlatformKey): FileRowModel[] => {
    const rec = downloads?.platforms.find(
      (x) => normalisePlatform(x.platform) === k,
    )?.recommended;
    const rows = model?.groups.find((g) => g.platform === k)?.rows ?? [];
    return rec
      ? rows.filter((r) => r.release.releaseId === rec.releaseId)
      : rows;
  };
  const rows = platform ? rowsOf(platform) : [];
  // The chosen build: the first covered file; the model already puts Universal and Apple silicon
  // first.
  const chosen = rows.find((r) => r.notIncluded === null) ?? null;
  const notCovered = rows.filter((r) => r.notIncluded !== null);
  const sources =
    model?.groups.find((g) => g.platform === platform)?.sources ?? [];
  const stores =
    downloads && platform ? liveStoresFor(downloads, platform) : [];
  const recommended = downloads?.platforms.find(
    (x) => normalisePlatform(x.platform) === platform,
  )?.recommended;
  const latest = downloads?.latest ?? null;
  const where = platform ? platformInSentence(platform) : null;
  const os = platform ? osName(platform) : null;

  // On a phone, a build for another OS is never downloaded: its link is mailed instead.
  const mailed = device.phone && platform !== device.os;
  const viewingDesktop =
    device.phone && platform !== null && DESKTOP.includes(platform);

  // The channel ("Stable"), with its day when this is the channel's newest release.
  const channel = downloads?.channel
    ? downloads.channel.charAt(0).toUpperCase() + downloads.channel.slice(1)
    : null;
  const day =
    chosen &&
    latest?.publishedAt != null &&
    chosen.release.releaseId === latest.releaseId
      ? formatDay(latest.publishedAt)
      : null;

  // The disclosure's rows, and where a phone's link to another platform leads: this page, with
  // every parameter it has (a declared `return=` goes on), asking for that platform.
  const others = otherBuilds({ platform, chosen, rowsOf, device });
  const kept = Object.fromEntries(params);
  if (allowedReturn(params.get("return"), product.returnTo) === null)
    delete kept.return;
  const switchHref = (k: PlatformKey): string =>
    href.focused(product.product, "download", { ...kept, platform: k });
  // After a phone's link has shown another platform, focus goes to the build line: it names the
  // new choice, and the primary is the next stop.
  const buildRef = React.useRef<HTMLParagraphElement>(null);
  const switching = React.useRef(false);
  React.useEffect(() => {
    if (!switching.current) return;
    switching.current = false;
    buildRef.current?.focus();
  }, [platform]);

  const source = chosen ? fileSource(chosen.artifact) : null;
  return (
    <TaskFrame
      slug={product.product}
      name={product.name}
      developer={pres.developer}
      tint={pres.tint}
      iconUrl={pres.iconUrl}
      task={t("boot.consent.download")}
      title={
        chosen
          ? t("locker.download.titleVersion", {
              product: product.name,
              version: chosen.release.version,
            })
          : t("locker.download.title", { product: product.name })
      }
    >
      <div className="space-y-5">
        {recommended && !recommended.latest && latest ? (
          <p className="text-sm text-fg-muted">{lastCovered(latest.version)}</p>
        ) : null}
        {chosen && platform && os ? (
          <div className="space-y-3">
            <div className="space-y-1">
              {viewingDesktop ? (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <Monitor aria-hidden className="size-4 shrink-0" />
                  {C["getIt.flow.desktopBuilds"]}
                </p>
              ) : null}
              {/* The separator rides on the end of the line before it (a no-break space), so a
                  wrapped line never starts with one. */}
              <p ref={buildRef} tabIndex={-1} data-build="" className="text-md">
                <span className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                  {os}, {chosen.title}
                </span>
                {source ? (
                  <>
                    <span className="text-fg-muted">{"\u00a0·"}</span>{" "}
                    <span className="whitespace-nowrap text-fg-muted">
                      {source}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row">
              {mailed ? (
                <EmailDownloadButton
                  product={product.product}
                  productName={product.name}
                  platform={platform}
                />
              ) : (
                <DownloadButton
                  product={product.product}
                  productName={product.name}
                  release={chosen.release}
                  artifact={chosen.artifact}
                  describe={`${os} ${chosen.title}`}
                  label={downloadFor(os)}
                  ariaLabel={downloadName(
                    os,
                    product.name,
                    chosen.release.version,
                    chosen.title,
                  )}
                  lead
                />
              )}
            </div>
          </div>
        ) : (
          <p className="flex gap-3 rounded-lg border border-border px-4 py-3 text-sm text-fg">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              {notCovered[0]?.notIncluded
                ? `${notCovered[0].notIncluded}.`
                : where
                  ? t("locker.download.noneFor", {
                      product: product.name,
                      detail: where,
                    })
                  : t("locker.download.none", { product: product.name })}
              {stores.length
                ? ` ${t("locker.download.inStore")}`
                : sources.length
                  ? ` ${C["getIt.flow.sourcesBelow"]}`
                  : ""}
            </span>
          </p>
        )}
        {chosen ? (
          <BuildDetails
            channel={channel ? (day ? `${channel} · ${day}` : channel) : null}
            sha256={chosen.artifact.sha256}
            hint={installHint(fileFormat(chosen.artifact.name), product.name)}
          />
        ) : null}
        <OtherBuilds
          key={platform ?? "none"}
          product={product.product}
          productName={product.name}
          builds={others}
          platform={platform}
          device={device}
          switchHref={switchHref}
          onSwitch={() => {
            switching.current = true;
          }}
        />
        <StorePills stores={stores} label={t("locker.offer.alsoOn")} />
        <InstallSourceList
          sources={sources}
          platform={platform}
          desktop={!device.phone}
          heading="h2"
        />
      </div>
    </TaskFrame>
  );
}
