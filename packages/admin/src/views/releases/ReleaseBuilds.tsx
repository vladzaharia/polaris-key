import * as React from "react";
import { Check, Copy } from "lucide-react";
import type {
  AppPinDto,
  ArtifactLocationDto,
  ReleaseArtifactDto,
  ReleaseBuildDto,
  ReleaseDto,
} from "../../api.js";
import { Badge, Button } from "../../components/ui/index.js";

/**
 * A release's builds and the files under each (P2-07). Reused by the distribution matrix
 * (P2b-06: the artifact and SHA-256 cells) and the pack views (P4-09), so it renders from the
 * admin read model alone (`GET …/release/releases`) and holds no state but the sidecar toggle.
 *
 * Sidecars — a signature or checksum file beside a payload — are collapsed by default: the
 * operator's question is "which bytes does this build ship", and a `.sig` per payload doubles
 * the list without answering it. A file no descriptor tied to a build (everything the GitHub
 * sync indexed for a legacy release) is listed on its own, under the builds.
 *
 * P4-09: an app release of a product with packs also shows its `contentApi`, the exact pack
 * release it pins for each pack, and an Embeds column (the packs each build ships embedded).
 * Nothing pack-related renders for a release that carries none of it.
 */
export function ReleaseBuilds({
  release,
}: {
  release: ReleaseDto;
}): React.ReactElement {
  const [showSidecars, setShowSidecars] = React.useState(false);
  const sidecars = release.artifacts.filter(isSidecar).length;
  const visible = showSidecars
    ? release.artifacts
    : release.artifacts.filter((a) => !isSidecar(a));
  const byBuild = new Map<string, ReleaseArtifactDto[]>();
  const loose: ReleaseArtifactDto[] = [];
  const known = new Set(release.builds.map((b) => b.buildId));
  const pins = release.pins ?? [];
  const hasContent =
    (release.contentApi !== undefined && release.contentApi !== null) ||
    pins.length > 0;
  const showEmbeds =
    hasContent ||
    release.builds.some((b) => b.embeds !== undefined && b.embeds !== null);
  for (const a of visible) {
    if (a.buildId && known.has(a.buildId)) {
      byBuild.set(a.buildId, [...(byBuild.get(a.buildId) ?? []), a]);
    } else {
      loose.push(a);
    }
  }

  return (
    <div className="space-y-3" aria-label={`Builds of ${release.version}`}>
      {hasContent ? (
        <ContentPins contentApi={release.contentApi ?? null} pins={pins} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">
          {release.builds.length
            ? `Builds (${release.builds.length})`
            : "No builds declared — files as the GitHub sync indexed them"}
        </p>
        {sidecars ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showSidecars}
            onClick={() => setShowSidecars((v) => !v)}
          >
            {showSidecars ? "Hide sidecars" : `Show sidecars (${sidecars})`}
          </Button>
        ) : null}
      </div>

      {release.builds.length ? (
        <div className="overflow-x-auto rounded-md border border-border bg-background">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Build
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Platform
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Arch
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Format
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Build number
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Minimum OS
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Payload SHA-256
                </th>
                {showEmbeds ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    Embeds
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {release.builds.map((b) => (
                <BuildRows
                  key={b.buildId}
                  build={b}
                  payload={release.artifacts.find(
                    (a) => a.buildId === b.buildId && a.role === "payload",
                  )}
                  artifacts={byBuild.get(b.buildId) ?? []}
                  showEmbeds={showEmbeds}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {loose.length ? (
        <div className="space-y-2">
          {release.builds.length ? (
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Files not tied to a build
            </p>
          ) : null}
          <ArtifactList artifacts={loose} />
        </div>
      ) : null}
    </div>
  );
}

function BuildRows({
  build,
  payload,
  artifacts,
  showEmbeds,
}: {
  build: ReleaseBuildDto;
  payload: ReleaseArtifactDto | undefined;
  artifacts: ReleaseArtifactDto[];
  showEmbeds: boolean;
}): React.ReactElement {
  return (
    <>
      <tr className="border-t border-border first:border-0">
        <td className="px-3 py-2 font-mono text-xs">{build.buildId}</td>
        <td className="px-3 py-2">{build.platform ?? "any"}</td>
        <td className="px-3 py-2">{build.arch}</td>
        <td className="px-3 py-2">{build.format ?? "—"}</td>
        <td className="px-3 py-2 font-mono text-xs">
          {build.buildNumber ?? "—"}
        </td>
        <td className="px-3 py-2">{build.minOs ?? "—"}</td>
        <td className="px-3 py-2">
          {payload?.sha256 ? <Sha256 value={payload.sha256} /> : "—"}
        </td>
        {showEmbeds ? (
          <td className="px-3 py-2">
            <Embeds embeds={build.embeds ?? null} />
          </td>
        ) : null}
      </tr>
      {artifacts.length ? (
        <tr>
          <td colSpan={showEmbeds ? 8 : 7} className="px-3 pb-3 pt-0">
            <ArtifactList artifacts={artifacts} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** An app release's content: its `contentApi` and the pack release pinned for each pack. */
function ContentPins({
  contentApi,
  pins,
}: {
  contentApi: number | null;
  pins: AppPinDto[];
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        Content API {contentApi ?? "—"} · Pins ({pins.length})
      </p>
      {pins.length ? (
        <ul className="space-y-1" aria-label="Pinned packs">
          {pins.map((p) => (
            <li
              key={p.pack}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-2 py-1.5 text-xs"
            >
              <span className="font-mono">{p.pack}</span>
              <span aria-hidden>→</span>
              <span className="font-mono">
                {p.packVersion ?? p.packReleaseId}
              </span>
              {p.packYank ? (
                <Badge
                  variant="destructive"
                  title={`Yanked by ${p.packYank.by}: ${p.packYank.reason}`}
                >
                  yanked
                </Badge>
              ) : null}
              <Badge variant={p.required ? "warning" : "outline"}>
                {p.required ? "required" : "optional"}
              </Badge>
              <span className="text-muted-foreground">{p.delivery}</span>
              <Sha256 value={p.recordSha256} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          This app release pins no pack.
        </p>
      )}
    </div>
  );
}

/** The packs a build embeds; "—" when its descriptor said nothing. */
function Embeds({ embeds }: { embeds: string[] | null }): React.ReactElement {
  if (embeds === null) return <span className="text-muted-foreground">—</span>;
  if (!embeds.length)
    return <span className="text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {embeds.map((e) => (
        <Badge key={e} variant="outline">
          <span className="font-mono">{e}</span>
        </Badge>
      ))}
    </span>
  );
}

/** One line per file: name, role, size, hash and where the bytes live. */
export function ArtifactList({
  artifacts,
}: {
  artifacts: ReleaseArtifactDto[];
}): React.ReactElement {
  return (
    <ul className="space-y-1">
      {artifacts.map((a) => (
        <li
          key={a.artifactId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-2 py-1.5 text-xs"
        >
          <span className="font-mono">{a.name}</span>
          <Badge variant={a.role === "payload" ? "primary" : "outline"}>
            {a.role ?? a.kind ?? "file"}
          </Badge>
          <span className="text-muted-foreground">
            {formatBytes(a.sizeBytes)}
          </span>
          {a.sha256 ? <Sha256 value={a.sha256} /> : null}
          <span className="flex flex-wrap gap-1">
            {locationLabels(a.locations).map((l) => (
              <Badge key={l} variant="default">
                {l}
              </Badge>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** True for the files that only vouch for another (a signature or checksum sidecar). */
export function isSidecar(a: Pick<ReleaseArtifactDto, "role">): boolean {
  return a.role === "signature" || a.role === "checksum";
}

const LOCATION_LABEL: Record<ArtifactLocationDto["provider"], string> = {
  r2: "R2",
  github: "GitHub",
  store: "Store",
  external: "External",
};

/**
 * Where the bytes live, as labels. A file only the GitHub sync knows has no declared locations:
 * the sync indexes GitHub release assets, so its bytes are on GitHub.
 */
export function locationLabels(
  locations: ArtifactLocationDto[] | null,
): string[] {
  if (!locations || locations.length === 0) return ["GitHub (synced)"];
  return [
    ...new Set(
      locations.map((l) => LOCATION_LABEL[l.provider] ?? String(l.provider)),
    ),
  ];
}

/** A SHA-256 shortened to its first 12 hex digits, with the full value one click away. */
export function Sha256({ value }: { value: string }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  // The "copied" reset is cancelled on unmount so it never outlives the view.
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (insecure context, denied permission): the full hash is in the title.
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-xs" title={value}>
        {value.slice(0, 12)}…
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy SHA-256 ${value}`}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </span>
  );
}

export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
