/** Users → Data: a record's file as a browser download. */

import * as React from "react";
import { api } from "../../../../api.js";
import { announce } from "../../../../ui/LiveRegion.js";
import { toast } from "../../../../ui/toast.js";
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

/**
 * Downloads one file. `refused` is true after the Worker asked for a fresh sign-in (the caller
 * shows `SignInAgain`); any other failure is a toast. `busy` names the file being fetched, so its
 * button reads as working and a second click does nothing.
 */
export function useFileDownload(
  slug: string,
  subject: string,
): {
  busy: string | null;
  refused: boolean;
  download: (collection: string, id: string, version?: number) => void;
} {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [refused, setRefused] = React.useState(false);
  const download = (collection: string, id: string, version?: number): void => {
    const key = `${collection}/${id}/${version ?? ""}`;
    if (busy !== null) return;
    setBusy(key);
    setRefused(false);
    api
      .syncFileDownload(slug, subject, collection, id, version)
      .then((blob) => {
        save(blob, version === undefined ? id : `${id}-v${version}`);
        announce("Download started");
      })
      .catch((e: unknown) => {
        if (needsSignIn(e)) setRefused(true);
        else toast.error(e, { context: { thing: "File" } });
      })
      .finally(() => setBusy(null));
  };
  return { busy, refused, download };
}
