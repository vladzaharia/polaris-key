import * as React from "react";
import { Check, Copy } from "lucide-react";
import type { ArtifactLocationDto, ReleaseArtifactDto } from "../../api.js";
import { Badge } from "../../components/ui/index.js";
import { artifactLabel } from "../../lib/buildLabels.js";

/**
 * TEMPORARY (docs/design/ADMIN.md §7.2, chunk 8 → chunk 9). The legacy Distribution matrix read
 * these from `views/releases/ReleaseBuilds.tsx`, which the Release chunk (8) deleted with the rest
 * of the old Release views. They are moved here unchanged, beside their one reader, until the
 * Distribution chunk (9) rebuilds `Matrix.tsx` and deletes `views/distribution/*`, this file
 * included.
 */

/**
 * One line per file: name, platform and arch, role, size, hash and where the bytes live. The
 * platform label is left out under a build row (`showPlatform={false}`), whose columns say it.
 */
export function ArtifactList({
  artifacts,
  showPlatform = true,
}: {
  artifacts: ReleaseArtifactDto[];
  showPlatform?: boolean;
}): React.ReactElement {
  return (
    <ul className="space-y-1">
      {artifacts.map((a) => {
        const label = showPlatform ? artifactLabel(a) : null;
        return (
          <li
            key={a.artifactId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 px-2 py-1.5 text-xs"
          >
            <span className="font-mono">{a.name}</span>
            {label ? (
              <Badge variant="outline" title={label.long}>
                {label.short}
              </Badge>
            ) : null}
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
        );
      })}
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
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
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
        className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
