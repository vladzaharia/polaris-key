import { act } from "@testing-library/react";
import { vi } from "vitest";

/** One file the page asked the browser to save: the name it gave it, and its bytes as text. */
export interface SavedFile {
  filename: string;
  text: () => Promise<string>;
}

/** Every file the page saved so far, and the way to put the browser's own saving back. */
export interface DownloadCapture {
  saved: SavedFile[];
  restore: () => void;
}

/**
 * The portal saves a download through an object URL and a clicked `<a download>` (`api.ts`'s
 * `saveDownload`). jsdom has no object URLs and saves nothing, so this stands in for both and
 * records every file the page would have saved. Call `restore` when the test is done.
 */
export function captureDownloads(): DownloadCapture {
  const blobs = new Map<string, Blob>();
  const saved: SavedFile[] = [];
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = (blob) => {
    const url = `blob:test/${blobs.size + 1}`;
    blobs.set(url, blob as Blob);
    return url;
  };
  URL.revokeObjectURL = () => undefined;
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      const blob = blobs.get(this.href);
      if (!blob) throw new Error(`saved ${this.href}, which is no object URL`);
      saved.push({ filename: this.download, text: () => blob.text() });
    });
  return {
    saved,
    restore: () => {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      click.mockRestore();
    },
  };
}

/**
 * A Worker answer the test releases when it says: the request stays pending until `resolve`. The
 * executor form, because this package's `lib` is ES2023 and `Promise.withResolvers` is ES2024.
 */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Let the page run on a moment, so a request a bug would have sent has gone out before a test
 * asserts that none was (a refresh after a refusal, a download on load).
 */
export function settle(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}
