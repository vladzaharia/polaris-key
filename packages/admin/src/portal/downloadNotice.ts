import * as React from "react";
import { t } from "../lib/copy.js";
import { toast } from "../ui/toast.js";
import { setParams } from "./router.js";

/**
 * A download that failed after the click (HA-09F). The Worker sends a refused redemption back
 * here (`#/p/<product>?download=failed`, or the Library without a product); this says so in the
 * person's terms, then drops the parameter so a reload does not say it again.
 */
export function useDownloadFailedNotice(params: URLSearchParams): void {
  const failed = params.get("download") === "failed";
  React.useEffect(() => {
    if (!failed) return;
    toast.error(t("getIt.downloadFailed"), {
      description: t("locker.error.downloadLink.toast"),
    });
    setParams({ download: null });
  }, [failed]);
}
