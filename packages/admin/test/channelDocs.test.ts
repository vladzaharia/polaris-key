/** A-22.7: a channel page's Docs button opens the channel's own page. */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "@polaris-key/manifest";
import { channelDocs } from "../src/lib/docsLinks.js";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../docs/src/content/docs/features/ship-builds/channels",
);

describe("channelDocs", () => {
  it("every channel lands on a page that exists", () => {
    for (const id of CHANNEL_IDS) {
      const slug = channelDocs(id).split("/").filter(Boolean).pop()!;
      const page = slug === "channels" ? "index" : slug;
      expect(existsSync(join(dir, `${page}.md`)), id).toBe(true);
    }
  });

  it("a channel with a page of its own opens it; the rest open the overview", () => {
    expect(channelDocs("app-store")).toBe(
      "/docs/features/ship-builds/channels/app-store/",
    );
    expect(channelDocs("altstore")).toBe(
      "/docs/features/ship-builds/channels/",
    );
    expect(channelDocs(undefined)).toBe("/docs/features/ship-builds/channels/");
  });
});
