/** Users → Data: a record's file as a browser download. */

import * as React from "react";
import { announce } from "../../../../ui/LiveRegion.js";
import { downloadSyncFile } from "../data.js";
import { needsSignIn } from "./SignInAgain.js";

/** Saves `blob` as `name` through a temporary link (the response is a file, not a page). */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface DownloadRequest {
  collection: string;
  id: string;
  /** Asks for this kept version; absent asks for the live file. */
  version?: number;
  /** The version the file is named for: the live file's current one, or `version`. */
  label: number;
}

/**
 * The saved name. It never carries the record id's own extension (the id is the person's text):
 * `<id>-v<n>.bin`, for the live file and a kept version alike.
 */
export const fileName = (r: DownloadRequest): string =>
  `${r.id}-v${r.label}.bin`;

export interface DownloadState {
  /** The file being fetched (`collection/id/label`), so its button reads as working. */
  busy: string | null;
  /** Bytes read so far and the total (0 when unknown), while `busy`. */
  progress: { loaded: number; total: number } | null;
  /** The Worker asked for a fresh sign-in (the caller shows `SignInAgain`). */
  refused: boolean;
  /** Any other failure: what failed and how to run it again. */
  failed: { name: string; retry: () => void } | null;
  download: (r: DownloadRequest) => void;
  /** Forget a refusal or a failure (the drawer closed). */
  clear: () => void;
}

export const downloadKey = (r: DownloadRequest): string =>
  `${r.collection}/${r.id}/${r.label}`;

export function useFileDownload(slug: string, subject: string): DownloadState {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [progress, setProgress] =
    React.useState<DownloadState["progress"]>(null);
  const [refused, setRefused] = React.useState(false);
  const [failed, setFailed] = React.useState<DownloadState["failed"]>(null);
  const running = React.useRef(false);
  const download = (r: DownloadRequest): void => {
    if (running.current) return;
    running.current = true;
    setBusy(downloadKey(r));
    setProgress(null);
    setRefused(false);
    setFailed(null);
    announce("Download started");
    downloadSyncFile(
      slug,
      subject,
      r.collection,
      r.id,
      r.version,
      (loaded, total) => setProgress({ loaded, total }),
    )
      .then((blob) => {
        save(blob, fileName(r));
        announce(`Downloaded ${fileName(r)}`);
      })
      .catch((e: unknown) => {
        if (needsSignIn(e)) setRefused(true);
        else setFailed({ name: r.id, retry: () => download(r) });
      })
      .finally(() => {
        running.current = false;
        setBusy(null);
        setProgress(null);
      });
  };
  const clear = (): void => {
    setRefused(false);
    setFailed(null);
  };
  return { busy, progress, refused, failed, download, clear };
}
