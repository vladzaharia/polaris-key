import * as React from "react";
import { ExternalLink } from "lucide-react";
import { CopyButton } from "../../../ui/CopyButton.js";
import type { PortalInstallSource } from "../../api.js";
import {
  GET_IT_COPY as C,
  copyLabel,
  otherWaysOn,
  qrAlt,
  scanHint,
  sourceName,
  versionLine,
} from "../../copy/getIt.js";
import { PLATFORM_NAME, PlatformGlyph, type PlatformKey } from "../Glyphs.js";
import { PILL_CLASS } from "../StorePills.js";

/**
 * "Other ways to install" (P0-48): a platform's install sources, after its files, on the product
 * page's Get it and in the focused download flow. Each works the way the public download page's
 * "Other ways to get it" does (`services/distribution/page/render.ts` `way()`), from the same
 * Worker data:
 *
 * - a source the phone adds (AltStore, SideStore, AltStore PAL, F-Droid, Obtainium) opens its
 *   **deep link**, never the source URL, which a browser shows as JSON (or, for F-Droid's bare
 *   `/repo`, a 404). The URL to paste by hand is copyable text below, with F-Droid's fingerprint;
 *   on a computer, the Worker's QR code of the deep link is there for the phone to scan;
 * - a command (Homebrew, Scoop, winget) is a code line with a named Copy button.
 */
export function InstallSourceList({
  sources,
  platform,
  desktop,
  heading: Heading = "h5",
}: {
  sources: readonly PortalInstallSource[];
  platform: PlatformKey | null;
  /** On a computer: show the QR codes a phone scans. */
  desktop: boolean;
  /** The heading's level where the list sits (`h5` under Get it's platform `h4`). */
  heading?: "h2" | "h3" | "h4" | "h5";
}): React.ReactElement | null {
  const id = React.useId();
  if (sources.length === 0) return null;
  return (
    <div>
      <Heading id={id} className="py-2 text-xs font-semibold text-fg-muted">
        {C["getIt.otherWays"]}
      </Heading>
      <ul
        aria-label={platform ? otherWaysOn(PLATFORM_NAME[platform]) : undefined}
        aria-labelledby={platform ? undefined : id}
        className="divide-y divide-border"
      >
        {sources.map((s) => (
          <InstallSourceItem
            key={s.id}
            source={s}
            platform={platform}
            desktop={desktop}
          />
        ))}
      </ul>
    </div>
  );
}

/** Kinds whose `url` is a source or repository to paste into the app, never a page to open. */
const PASTE_KINDS: readonly string[] = [
  "altstore",
  "sidestore",
  "altstore-pal",
  "fdroid",
];

const httpsOnly = (url: string | null): string | null =>
  url && /^https:\/\//.test(url) ? url : null;

function InstallSourceItem({
  source: s,
  platform,
  desktop,
}: {
  source: PortalInstallSource;
  platform: PlatformKey | null;
  desktop: boolean;
}): React.ReactElement {
  const name = sourceName(s);
  const paste = PASTE_KINDS.includes(s.kind) ? httpsOnly(s.url) : null;
  // A page to open in a new tab: Obtainium's web hand-off, or a source with no deep link.
  const web = paste ? null : httpsOnly(s.url);
  return (
    <li className="flex gap-3 py-3">
      <span className="inline-flex size-8 shrink-0 items-center justify-center text-fg-muted">
        {platform ? (
          <PlatformGlyph platform={platform} className="size-5" />
        ) : null}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium text-fg-strong">{name}</p>
            {s.version ? (
              <p className="text-sm text-fg-muted">{versionLine(s.version)}</p>
            ) : null}
          </div>
          {s.deepLink ? (
            <a href={s.deepLink} className={PILL_CLASS}>
              {s.label}
            </a>
          ) : web && !s.command ? (
            <SourceWebLink href={web} label={s.label} />
          ) : null}
        </div>
        {s.command ? (
          <CopyField
            value={s.command}
            copy={copyLabel("command", name)}
            caption={null}
          />
        ) : null}
        {paste ? (
          <CopyField
            value={paste}
            copy={copyLabel(
              s.kind === "fdroid" ? "repository" : "source",
              name,
            )}
            caption={
              s.kind === "fdroid"
                ? C["getIt.repositoryUrl"]
                : C["getIt.sourceUrl"]
            }
          />
        ) : null}
        {s.kind === "fdroid" ? (
          s.fingerprint ? (
            <CopyField
              value={s.fingerprint}
              copy={copyLabel("fingerprint", name)}
              caption={C["getIt.fingerprint"]}
            />
          ) : (
            <p className="text-sm text-fg-muted">{C["getIt.noFingerprint"]}</p>
          )
        ) : null}
        {s.kind === "obtainium" && s.deepLink && web ? (
          <SourceWebLink href={web} label={C["getIt.obtainiumWeb"]} quiet />
        ) : null}
        {desktop && s.qr ? (
          <div className="flex items-center gap-3">
            <img
              src={s.qr}
              alt={qrAlt(s.label)}
              width={112}
              height={112}
              className="size-28 shrink-0 rounded-md border border-border bg-white"
            />
            <p className="text-sm text-fg-muted">{scanHint(platform, name)}</p>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** An https page in a new tab, said so to a screen reader. */
function SourceWebLink({
  href,
  label,
  quiet = false,
}: {
  href: string;
  label: string;
  quiet?: boolean;
}): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={
        quiet
          ? "inline-flex items-center gap-1 text-sm font-medium text-accent-fg hover:underline"
          : PILL_CLASS
      }
    >
      {label}
      <ExternalLink aria-hidden className="size-4 text-accent-fg" />
      <span className="sr-only">{C["getIt.newTab"]}</span>
    </a>
  );
}

/** A value to copy (a command, a URL, a fingerprint): the text in full, wrapped at its seams,
 *  and a Copy button named for what it copies (the shared `CopyButton`, as `Hash` uses). */
function CopyField({
  value,
  copy,
  caption,
}: {
  value: string;
  copy: string;
  caption: string | null;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      {caption ? <p className="text-xs text-fg-muted">{caption}</p> : null}
      {/* The button sits beside the value while the value keeps 16rem, else under it (a phone). */}
      <div className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-surface-sunken py-1.5 pl-3 pr-1.5">
        <code className="min-w-[min(100%,16rem)] flex-1 break-words py-1 font-mono text-xs leading-5 text-fg-strong">
          <Breakable text={value} />
        </code>
        <CopyButton
          value={value}
          label={copy}
          showLabel
          size="sm"
          className="ml-auto shrink-0"
        />
      </div>
    </div>
  );
}

/**
 * Where a URL or command may wrap: after a `/` (never inside `//`), before `?` and `&`, after `=`,
 * at its spaces, and every 8 characters of a hex run of 16 or more (a fingerprint), so no line
 * ends in a stray character. Never inside a word.
 */
export function breakPoints(text: string): string[] {
  return text
    .split(/(?<=\/)(?!\/)|(?=[?&])|(?<==)/)
    .flatMap((p) =>
      p.replace(/([0-9a-f]{8})(?=[0-9a-f]{8})/gi, "$1\u0000").split("\u0000"),
    )
    .filter((p) => p !== "");
}

function Breakable({ text }: { text: string }): React.ReactElement {
  const parts = breakPoints(text);
  return (
    <>
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          {p}
        </React.Fragment>
      ))}
    </>
  );
}
