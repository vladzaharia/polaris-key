import * as React from "react";
import { Info } from "lucide-react";
import { Skeleton } from "../../ui/Skeleton.js";
import type { PortalAccount, PortalDownloads, PortalProduct } from "../api.js";
import { PLATFORM_ORDER, type PlatformKey } from "../components/Glyphs.js";
import { FlowCard, FocusedFlow } from "../components/FocusedFlow.js";
import { StorePills } from "../components/StorePills.js";
import { ErrorPanel } from "../components/States.js";
import { DownloadButton } from "../components/product/DownloadButton.js";
import { useProduct, useProductDownloads } from "../data.js";
import { isNotFound } from "../errors.js";
import {
  detectDevice,
  normalisePlatform,
  osName,
  presentationFrom,
} from "../model/library.js";
import { getItFromDownloads, type FileRowModel } from "../model/product.js";
import { allowedReturn } from "../model/returnUrl.js";
import { href, useDocumentTitle } from "../router.js";
import { flowBack } from "./FreeDevicePage.js";
import { NotFoundProduct } from "./NotFoundProduct.js";

/** `?platform=` when it names a platform, else the device in hand, else the Worker's guess. */
export function flowPlatform(
  param: string | null,
  d: PortalDownloads,
): PlatformKey | null {
  const asked = normalisePlatform(param);
  if (asked) return asked;
  const here = detectDevice().os;
  return here ?? normalisePlatform(d.detected.platform);
}

const PLATFORM_LABEL: Record<PlatformKey, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iPhone and iPad",
  android: "Android",
  web: "the web",
};

/**
 * One download, the focused flow (PORTAL.md §3.3, §3.4, PX-10): `#/p/<product>/download?platform=`,
 * the target of "Email me the download" and an app's "Download update". The platform's builds from
 * the downloads view (PX-W2) with their reasons as text, its stores, and a link to every platform;
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
    p ? `Download ${p.name}` : product.isPending ? null : "Download",
  );
  const returnUrl = p ? allowedReturn(params.get("return"), p.returnTo) : null;
  const back = flowBack(slug, p?.name ?? "the product", returnUrl);
  const pending =
    product.isPending || (product.isSuccess && downloads.isPending);
  const error = product.error ?? downloads.error;
  return (
    <FocusedFlow back={back}>
      {pending ? (
        <div aria-busy className="mx-auto max-w-[41rem]">
          <h1 className="sr-only">Loading</h1>
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      ) : product.error && isNotFound(product.error) ? (
        <NotFoundProduct email={account.email} />
      ) : error || !p ? (
        <ErrorPanel
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
          platformParam={params.get("platform")}
        />
      )}
    </FocusedFlow>
  );
}

function DownloadBody({
  product,
  downloads,
  platformParam,
}: {
  product: PortalProduct;
  downloads: PortalDownloads | null;
  platformParam: string | null;
}): React.ReactElement {
  const pres = presentationFrom(product);
  const model = downloads
    ? getItFromDownloads(downloads, detectDevice(), {
        developer: pres.developer,
        website: pres.website,
      })
    : null;
  const platform = downloads ? flowPlatform(platformParam, downloads) : null;
  const rows: FileRowModel[] =
    model?.groups.find((g) => g.platform === platform)?.rows ?? [];
  // The newest covered build per arch: a release older than the recommendation is history.
  const recommended = downloads?.platforms.find(
    (x) => normalisePlatform(x.platform) === platform,
  )?.recommended;
  const covered = rows.filter(
    (r) =>
      r.notIncluded === null &&
      (!recommended || r.release.releaseId === recommended.releaseId),
  );
  const notCovered = rows.filter((r) => r.notIncluded !== null);
  const stores = (downloads?.stores ?? []).filter(
    (s) => s.live && s.url && platform && s.platforms.includes(platform),
  );
  const where = platform ? PLATFORM_LABEL[platform] : null;
  const others = PLATFORM_ORDER.filter(
    (k) => k !== platform && model?.groups.some((g) => g.platform === k),
  );
  return (
    <FlowCard
      slug={product.product}
      name={product.name}
      developer={pres.developer}
      tint={pres.tint}
      iconUrl={pres.iconUrl}
      headerUrl={pres.headerUrl}
    >
      <div className="mt-2 space-y-5">
        <h1 className="text-headline font-bold leading-tight text-fg-strong desk:text-headline-lg">
          {where
            ? `Download ${product.name} for ${where}`
            : `Download ${product.name}`}
        </h1>
        {covered.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {covered.map((r) => (
              <li
                key={r.artifact.artifactId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block font-bold text-fg-strong">
                    {r.title}
                  </span>
                  <span className="block font-mono text-sm text-fg-muted">
                    {r.meta}
                  </span>
                </span>
                <DownloadButton
                  product={product.product}
                  productName={product.name}
                  release={r.release}
                  artifact={r.artifact}
                  describe={`${where ?? ""} ${r.title}`.trim()}
                  lead={covered.length === 1}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex gap-3 rounded-lg border border-border px-4 py-3 text-sm text-fg">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              {notCovered[0]?.notIncluded
                ? `${notCovered[0].notIncluded}.`
                : where
                  ? `${product.name} has no download for ${where} here.`
                  : `${product.name} has no download here.`}
              {stores.length ? " It's available in a store below." : ""}
            </span>
          </p>
        )}
        {recommended && !recommended.latest && downloads?.latest ? (
          <p className="text-sm text-fg-muted">
            This is the last version your license covers. Version{" "}
            {downloads.latest.version} isn't included.
          </p>
        ) : null}
        <StorePills stores={stores} label="Also on" />
        <p className="text-sm text-fg-muted">
          Download links are made fresh when you click, so they never go stale.
        </p>
        <p className="text-sm">
          <a
            href={href.product(product.product, "get")}
            className="font-bold text-accent-fg hover:underline"
          >
            {others.length
              ? `Other platforms: ${others.map((k) => osName(k)).join(", ")}`
              : `Everything about ${product.name}`}
          </a>
        </p>
      </div>
    </FlowCard>
  );
}
