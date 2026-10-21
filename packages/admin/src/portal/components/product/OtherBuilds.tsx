import * as React from "react";
import { ChevronRight, ExternalLink, Info } from "lucide-react";
import { cn } from "../../../lib/cn.js";
import { Expand } from "../../../ui/motion/index.js";
import { GET_IT_COPY as C } from "../../copy/getIt.js";
import { osName, type DeviceInHand } from "../../model/library.js";
import {
  fileFormat,
  fileSource,
  type FileRowModel,
} from "../../model/product.js";
import { PLATFORM_ORDER, PlatformGlyph, type PlatformKey } from "../Glyphs.js";
import { DownloadButton } from "./DownloadButton.js";

/**
 * The builds the disclosure lists (PORTAL.md §4.25 item 4), in order: the other builds of the
 * chosen platform (another architecture or format; the model already puts Universal and Apple
 * silicon first), then every other platform in `PLATFORM_ORDER`.
 *
 * - With no chosen build (the page says why) the platform's own rows are that reason, not
 *   alternatives, so only the other platforms are listed.
 * - A phone cannot pick a build of a desktop platform, and the link it mails opens the page where
 *   one can: it lists another platform once, by the build the page leads with when it is
 *   chosen, and none of the chosen desktop platform's other builds. A build of the phone's own OS
 *   is listed in full.
 */
export function otherBuilds({
  platform,
  chosen,
  rowsOf,
  device,
}: {
  platform: PlatformKey | null;
  chosen: FileRowModel | null;
  rowsOf: (platform: PlatformKey) => readonly FileRowModel[];
  device: DeviceInHand;
}): FileRowModel[] {
  const mailed = device.phone && platform !== device.os;
  const same =
    platform && chosen && !mailed
      ? rowsOf(platform).filter((r) => r !== chosen)
      : [];
  const rest = PLATFORM_ORDER.filter((k) => k !== platform).flatMap((k) => {
    const rows = rowsOf(k);
    if (!device.phone || k === device.os) return rows;
    const lead = rows.find((r) => r.notIncluded === null) ?? rows[0];
    return lead ? [lead] : [];
  });
  return [...same, ...rest];
}

/** What a row's action is: its own download, a switch of the page's platform, or words. */
type RowAction = "download" | "switch" | "elsewhere" | "reason";

function actionOf(row: FileRowModel, device: DeviceInHand): RowAction {
  if (row.elsewhere) return "elsewhere";
  if (row.notIncluded !== null) return "reason";
  return device.phone && row.platform !== null && row.platform !== device.os
    ? "switch"
    : "download";
}

/** "Windows x64", "macOS Intel": the platform and architecture a row is for. */
function rowName(row: FileRowModel): string {
  return row.platform ? `${osName(row.platform)} ${row.title}` : row.title;
}

/**
 * "Other platforms and architectures": one bordered row that opens the builds above, closed to
 * begin with (an `Expand`, so the controls above never move). The summary names what is inside:
 * the chosen platform's other builds by architecture, the other platforms by OS.
 *
 * On a computer a covered row downloads. On a phone a row for another OS is a link that asks the
 * page for that platform (`switchHref`, which keeps `return=`): the page then offers to email
 * that build, never to download it. A row the license doesn't cover says why in words, and a
 * file this site doesn't host says where to get it, as Get it does.
 */
export function OtherBuilds({
  product,
  productName,
  builds,
  platform,
  device,
  switchHref,
  onSwitch,
}: {
  product: string;
  productName: string;
  /** `otherBuilds`' answer. */
  builds: readonly FileRowModel[];
  /** The chosen platform: its builds are named by architecture. */
  platform: PlatformKey | null;
  device: DeviceInHand;
  /** Where a phone's row for `platform` leads: this page, asking for it. */
  switchHref: (platform: PlatformKey) => string;
  /** A phone's row was followed: the page is about to show another platform. */
  onSwitch?: () => void;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const region = React.useId();
  if (builds.length === 0) return null;
  const summary = [
    ...new Set(
      builds.map((b) =>
        b.platform === platform || !b.platform
          ? rowName(b)
          : osName(b.platform),
      ),
    ),
  ].join(", ");
  // Two rows that read the same ("Linux x86_64": a .deb and an .rpm) are told apart in their
  // accessible names by the format the muted line shows.
  const count = new Map<string, number>();
  for (const b of builds)
    count.set(rowName(b), (count.get(rowName(b)) ?? 0) + 1);
  const describe = (b: FileRowModel): string => {
    const format = fileFormat(b.artifact.name);
    return (count.get(rowName(b)) ?? 0) > 1 && format
      ? `${rowName(b)} .${format}`
      : rowName(b);
  };
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-dashed border-border-strong px-4 @max-[18rem]:px-2 py-2 text-left hover:bg-hover"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-fg-muted transition-transform duration-(--pk-duration-fast)",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-fg-strong @max-[18rem]:text-xs">
            {C["getIt.flow.otherBuilds"]}
          </span>{" "}
          <span className="block text-sm text-fg-muted [overflow-wrap:anywhere]">
            {summary}
          </span>
        </span>
      </button>
      {/* -mx-1 and px-1: room for a focus ring inside the region's clip. */}
      <Expand open={open} id={region} className="-mx-1">
        <div className="px-1 pb-1 pt-3">
          <ul
            aria-label={C["getIt.flow.otherBuilds"]}
            className="divide-y divide-border rounded-xl border border-border bg-surface-raised"
          >
            {builds.map((b) => (
              <BuildRow
                key={b.artifact.artifactId}
                row={b}
                action={actionOf(b, device)}
                describe={describe(b)}
                product={product}
                productName={productName}
                switchHref={switchHref}
                onSwitch={onSwitch}
              />
            ))}
          </ul>
        </div>
      </Expand>
    </div>
  );
}

function BuildRow({
  row,
  action,
  describe,
  product,
  productName,
  switchHref,
  onSwitch,
}: {
  row: FileRowModel;
  action: RowAction;
  describe: string;
  product: string;
  productName: string;
  switchHref: (platform: PlatformKey) => string;
  onSwitch?: () => void;
}): React.ReactElement {
  const source = fileSource(row.artifact);
  const text = (
    <>
      <span className="inline-flex size-8 shrink-0 items-center justify-center text-fg-muted">
        {row.platform ? (
          <PlatformGlyph platform={row.platform} className="size-5" />
        ) : null}
      </span>
      {/* A 9 rem floor: a narrow screen moves the action to its own line instead of squeezing
          the name to a letter per line. */}
      <span className="min-w-0 flex-[1_1_9rem]">
        <span
          data-build-name=""
          className="block font-medium text-fg-strong [overflow-wrap:anywhere]"
        >
          {rowName(row)}
        </span>{" "}
        {source ? (
          <span className="block text-sm text-fg-muted">{source}</span>
        ) : null}{" "}
        {action === "reason" ? (
          <span className="mt-1 flex items-start gap-2 text-sm text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{row.notIncluded}</span>
          </span>
        ) : null}
      </span>
    </>
  );
  if (action === "switch" && row.platform) {
    return (
      <li className="first:rounded-t-xl last:rounded-b-xl">
        <a
          href={switchHref(row.platform)}
          onClick={onSwitch}
          className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-hover first:rounded-t-xl last:rounded-b-xl"
        >
          {text}
          <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-muted" />
        </a>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      {text}
      {action === "download" ? (
        <DownloadButton
          product={product}
          productName={productName}
          release={row.release}
          artifact={row.artifact}
          describe={describe}
        />
      ) : action === "elsewhere" && row.elsewhere ? (
        row.elsewhere.href ? (
          <a
            href={row.elsewhere.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium text-fg-strong hover:bg-hover"
          >
            {row.elsewhere.label}
            <ExternalLink aria-hidden className="size-4" />
            <span className="sr-only">{C["getIt.newTab"]}</span>
          </a>
        ) : (
          <span className="text-sm font-medium text-fg-strong">
            {row.elsewhere.label}
          </span>
        )
      ) : null}
    </li>
  );
}
