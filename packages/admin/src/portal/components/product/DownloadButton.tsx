import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
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
}): React.ReactElement {
  const start = useStartDownload();
  return (
    <Button
      variant={lead ? "primary" : "quiet"}
      size={lead ? "lg" : "md"}
      className={lead ? "h-12 px-6" : "h-10"}
      loading={start.isPending}
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
            onError: (err) =>
              toast.error(t("getIt.downloadFailed"), {
                description: portalErrorCopy(err).description,
              }),
          },
        )
      }
    >
      {label}
    </Button>
  );
}
