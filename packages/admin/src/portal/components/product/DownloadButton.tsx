import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { announce } from "../../../ui/LiveRegion.js";
import type { PortalArtifact, PortalRelease } from "../../api.js";
import { useStartDownload } from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { t } from "../../../lib/copy.js";

/**
 * Download one file through a fresh link. `lead` for the recommended build. The accessible name
 * is "<label> <product> <version> for <describe>" unless `ariaLabel` words it: a caller whose
 * `label` already says where ("Download for macOS") passes one that begins with that label.
 */
export function DownloadButton({
  product,
  productName,
  release,
  artifact,
  describe,
  lead = false,
  label = t("boot.consent.download"),
  ariaLabel,
  table = false,
}: {
  product: string;
  productName: string;
  release: PortalRelease;
  artifact: PortalArtifact;
  /** What the file is, for the accessible name ("macOS Universal"). */
  describe: string;
  lead?: boolean;
  label?: string;
  /** The accessible name; it must contain `label` (WCAG label in name). */
  ariaLabel?: string;
  /**
   * A row of the downloads table: 44 px high, and below `sm` a 44 px square with the glyph alone
   * (the accessible name carries the words).
   */
  table?: boolean;
}): React.ReactElement {
  const start = useStartDownload();
  const alertId = React.useId();
  return (
    <div
      className={
        table
          ? "flex min-w-0 flex-col items-end gap-2"
          : "flex min-w-0 flex-col items-stretch gap-2 sm:items-start"
      }
    >
      <Button
        variant={lead ? "primary" : "quiet"}
        size={lead ? "lg" : "md"}
        className={
          lead
            ? "h-auto min-h-12 whitespace-normal px-6"
            : table
              ? "size-11 px-0 sm:h-11 sm:w-auto sm:px-4"
              : "h-auto min-h-10 whitespace-normal"
        }
        loading={start.isPending}
        busyFocusable
        aria-describedby={start.isError ? alertId : undefined}
        iconStart={<Download aria-hidden />}
        aria-label={
          ariaLabel ??
          t("getIt.downloadAria", {
            name: label,
            product: productName,
            version: release.version,
            platform: describe,
          })
        }
        onClick={() =>
          start.mutate(
            {
              product,
              releaseId: release.releaseId,
              artifactId: artifact.artifactId,
            },
            {
              onSuccess: () =>
                announce(
                  t("getIt.downloading", {
                    product: productName,
                    version: release.version,
                    platform: describe,
                  }),
                ),
            },
          )
        }
      >
        {table ? (
          <span className="sr-only sm:not-sr-only">{label}</span>
        ) : (
          label
        )}
      </Button>
      {start.isError ? (
        <p id={alertId} role="alert" className="text-sm text-danger">
          {t("getIt.downloadFailed")}.{" "}
          {portalErrorCopy(start.error).description}
        </p>
      ) : null}
    </div>
  );
}
