/**
 * The winget generator (A-18i; notes/S-15 §4.4): one version's multi-file manifest at schema
 * **1.12.0** for `microsoft/winget-pkgs`, under `manifests/<p>/<Publisher>/<Package>/<version>/`:
 *
 *   <id>.yaml                   the version manifest (`ManifestType: version`)
 *   <id>.installer.yaml         one installer per Windows build: the release's HTTPS direct
 *                               delivery URL and SHA-256 (`zip` with a nested portable, `portable`,
 *                               `msi` or `msix`, from the file name)
 *   <id>.locale.<default>.yaml  the default locale (`defaultLocale`): the listing model's winget
 *                               projection plus the app-level Publisher, URLs, Copyright, License
 *   <id>.locale.<other>.yaml    one `locale` file per further locale the projection carries
 *
 * Every version is validated by a pipeline and then reviewed by a moderator: the flow shows the PR
 * and its labels, never a date. `test/fixtures/winget-schema-1.12.0/` holds the published schemas
 * and the suite validates the golden output against them.
 */

import { Document } from "yaml";
import {
  isHttps,
  isoDate,
  needPayload,
  needRelease,
  type GeneratedFile,
  type PrInputBuild,
  type PrInputs,
} from "./prInputs.js";

export const WINGET_MANIFEST_VERSION = "1.12.0";

export interface WingetOptions {
  /**
   * For a `.zip` build: the executable inside the archive (`NestedInstallerFiles`), a relative
   * path. Required when a Windows build is a zip.
   */
  portable?: string;
  /** The command alias a portable install puts on PATH (`PortableCommandAlias`). */
  command?: string;
  /** The `License` the default locale names (winget requires one). Default `Proprietary`. */
  license?: string;
}

/** winget's architecture for a release build's, or null when winget has none. */
const ARCH: Readonly<Record<string, string>> = {
  x86_64: "x64",
  x64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
  x86: "x86",
  i686: "x86",
  universal: "neutral",
  neutral: "neutral",
};

/** The installer type a build's file name implies, or null for one winget cannot install. */
export function wingetInstallerType(
  name: string,
): "zip" | "portable" | "msi" | "msix" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".zip")) return "zip";
  if (n.endsWith(".exe")) return "portable";
  if (n.endsWith(".msi")) return "msi";
  if (n.endsWith(".msix") || n.endsWith(".msixbundle")) return "msix";
  return null;
}

/** The directory a package version's manifests live in. */
export function wingetDir(id: string, version: string): string {
  return `manifests/${id.charAt(0).toLowerCase()}/${id.split(".").join("/")}/${version}`;
}

/** The package's directory (every version under it). */
export function wingetPackageDir(id: string): string {
  return `manifests/${id.charAt(0).toLowerCase()}/${id.split(".").join("/")}`;
}

/** A winget tag: lower-case, spaces as hyphens, at most 40 characters. */
function tag(t: string): string | null {
  const v = t.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
  return v.length ? v : null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

function yamlFile(
  kind: "version" | "installer" | "defaultLocale" | "locale",
  body: Record<string, unknown>,
): string {
  const clean = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined && v !== null),
  );
  const doc = new Document(clean);
  doc.commentBefore = ` Created with Polaris Key (pkey storefront winget)\n yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${WINGET_MANIFEST_VERSION}.schema.json`;
  return doc.toString({ lineWidth: 0 });
}

function installer(
  b: PrInputBuild,
  date: string | null,
  o: WingetOptions,
): Record<string, unknown> {
  const arch = ARCH[b.arch];
  if (!arch)
    throw new Error(
      `${b.name}: winget has no architecture for ${b.arch} (x64, x86, arm64 or neutral).`,
    );
  if (!isHttps(b.url))
    throw new Error(
      `${b.name}: winget needs an HTTPS direct installer URL (got ${b.url}).`,
    );
  if (!b.sha256)
    throw new Error(`${b.name}: the release records no SHA-256 for it.`);
  const type = wingetInstallerType(b.name);
  if (!type)
    throw new Error(
      `${b.name}: winget installs a .zip (with a portable executable inside), .exe, .msi or .msix.`,
    );
  const out: Record<string, unknown> = {
    Architecture: arch,
    InstallerType: type,
  };
  if (type === "zip") {
    if (!o.portable)
      throw new Error(
        `${b.name} is a zip: pass --portable <path of the executable inside it>.`,
      );
    if (
      o.portable.startsWith("/") ||
      o.portable.includes("..") ||
      /^[A-Za-z]:/.test(o.portable)
    )
      throw new Error(
        `--portable must be a relative path inside the archive (got ${o.portable}).`,
      );
    out.NestedInstallerType = "portable";
    out.NestedInstallerFiles = [
      {
        RelativeFilePath: o.portable.replace(/\//g, "\\"),
        ...(o.command ? { PortableCommandAlias: o.command } : {}),
      },
    ];
  } else if (type === "portable" && o.command) {
    out.Commands = [o.command];
  }
  out.InstallerUrl = b.url;
  out.InstallerSha256 = b.sha256.toUpperCase();
  if (date) out.ReleaseDate = date;
  return out;
}

/** Generate the winget manifests for the inputs' release. */
export function generateWinget(
  i: PrInputs,
  o: WingetOptions = {},
): GeneratedFile[] {
  const id = str(i.outlet.identity.packageIdentifier);
  if (!id)
    throw new Error(
      `The ${i.outlet.id} outlet declares no packageIdentifier in .pkey/distribution.`,
    );
  if (
    o.command !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(o.command)
  )
    throw new Error(
      `--command must be 1-40 letters, digits, ., _ or - (got ${o.command}).`,
    );
  const release = needRelease(i);
  const version = release.version;
  const payload = needPayload(i, "winget");
  const builds = release.builds.filter(
    (b) => b.platform === null || b.platform === "windows",
  );
  if (builds.length === 0)
    throw new Error(
      `${version} has no Windows build on the ${i.outlet.id} outlet.`,
    );
  const date = isoDate(release.publishedAt);
  const installers = builds.map((b) => installer(b, date, o));
  const seen = new Set<string>();
  for (const x of installers) {
    const key = `${x.Architecture}/${x.InstallerType}`;
    if (seen.has(key))
      throw new Error(
        `${version} has two ${x.InstallerType} builds for ${x.Architecture}; winget takes one per architecture and type.`,
      );
    seen.add(key);
  }

  const head = { PackageIdentifier: id, PackageVersion: version };
  const defaultLocale = i.app.defaultLocale;
  const locales = Object.keys(payload.locales).sort((a, b) =>
    a === defaultLocale ? -1 : b === defaultLocale ? 1 : a.localeCompare(b),
  );
  if (!locales.includes(defaultLocale))
    throw new Error(
      `The listing's winget projection has nothing for the default locale ${defaultLocale}.`,
    );

  const dir = wingetDir(id, version);
  const files: GeneratedFile[] = [
    {
      path: `${dir}/${id}.yaml`,
      content: yamlFile("version", {
        ...head,
        DefaultLocale: defaultLocale,
        ManifestType: "version",
        ManifestVersion: WINGET_MANIFEST_VERSION,
      }),
    },
    {
      path: `${dir}/${id}.installer.yaml`,
      content: yamlFile("installer", {
        ...head,
        Installers: installers,
        ManifestType: "installer",
        ManifestVersion: WINGET_MANIFEST_VERSION,
      }),
    },
  ];

  const app = payload.app;
  for (const locale of locales) {
    const l = payload.locales[locale] ?? {};
    const tags = Array.isArray(l.Tags)
      ? [
          ...new Set(
            (l.Tags as unknown[])
              .filter((t): t is string => typeof t === "string")
              .map(tag)
              .filter((t): t is string => t !== null),
          ),
        ].slice(0, 16)
      : [];
    const isDefault = locale === defaultLocale;
    const body: Record<string, unknown> = {
      ...head,
      PackageLocale: locale,
      ...(isDefault
        ? {
            Publisher: str(app.Publisher),
            PublisherUrl: i.app.website ?? undefined,
            PublisherSupportUrl: str(app.PublisherSupportUrl),
            PrivacyUrl: str(app.PrivacyUrl),
          }
        : {}),
      PackageName: str(l.PackageName),
      ...(isDefault
        ? {
            PackageUrl: i.app.website ?? undefined,
            License: o.license ?? "Proprietary",
            Copyright: str(app.Copyright),
          }
        : {}),
      ShortDescription: str(l.ShortDescription),
      Description: str(l.Description),
      Tags: tags.length ? tags : undefined,
      ReleaseNotes: str(l.ReleaseNotes),
      ManifestType: isDefault ? "defaultLocale" : "locale",
      ManifestVersion: WINGET_MANIFEST_VERSION,
    };
    if (isDefault)
      for (const req of ["Publisher", "PackageName", "ShortDescription"])
        if (body[req] === undefined)
          throw new Error(
            `The listing's winget projection has no ${req} in the default locale ${defaultLocale}.`,
          );
    files.push({
      path: `${dir}/${id}.locale.${locale}.yaml`,
      content: yamlFile(isDefault ? "defaultLocale" : "locale", body),
    });
  }
  return files;
}
