import { act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ACCOUNT, NOW_S } from "./portalHarness.js";

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

/**
 * `GET /api/me/methods` for an account whose sign-in is older than five minutes: one email, the
 * last link, so the confirm-it's-you prompt offers a code to that address.
 */
export const STALE = {
  methods: [
    {
      id: "lnk_mail1",
      kind: "email",
      group: "email",
      label: "Email",
      display: ACCOUNT.email,
      connectedAt: NOW_S - 90 * 86_400,
      lastUsedAt: NOW_S - 3 * 86_400,
      canRemove: false,
      reason: "last_link",
      flag: null,
      relay: false,
      tenantScoped: false,
    },
  ],
  emails: [
    {
      methodId: "lnk_mail1",
      email: ACCOUNT.email,
      primary: true,
      connectedAt: NOW_S - 90 * 86_400,
      lastUsedAt: NOW_S - 3 * 86_400,
      canRemove: false,
      reason: "last_link",
    },
  ],
  passkeys: [],
  providers: [],
  passkey: { canAdd: false, reason: null },
  primaryEmail: ACCOUNT.email,
  hideMyEmail: false,
  stepUp: {
    authenticatedAt: NOW_S - 3600,
    freshUntil: NOW_S - 3300,
    fresh: false,
    maxAgeSeconds: 300,
  },
};

/** Confirm it's you with an email code, in the prompt that replaced the refusal. */
export async function confirmItsYou(scope: HTMLElement): Promise<void> {
  const prompt = await within(scope).findByRole("group", {
    name: "Confirm it's you first",
  });
  await userEvent.click(
    within(prompt).getByRole("button", {
      name: `Email me a code at ${ACCOUNT.email}`,
    }),
  );
  await userEvent.type(
    await within(prompt).findByRole("textbox", { name: "6-digit code" }),
    "481920",
  );
}
