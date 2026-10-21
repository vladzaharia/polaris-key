/**
 * `/docs/help/code/<id>/` (docs plan §3.1, §7.4): one static redirect page per message id, landing
 * on the id's own anchor of its messages page (ids that share an entry keep their own anchor).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HELP_MESSAGES,
  helpCodeRedirects,
  helpMessageUrl,
} from "../src/lib/helpMessages";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

describe("helpCodeRedirects", () => {
  const ids = [
    ...Object.keys(HELP_MESSAGES.messages),
    ...HELP_MESSAGES.developerOnly,
  ];

  it("maps every message id to its own anchor", () => {
    const map = helpCodeRedirects();
    expect(Object.keys(map)).toHaveLength(ids.length);
    for (const id of ids)
      expect(map[`/help/code/${id}`], id).toBe(
        helpMessageUrl(HELP_MESSAGES, id),
      );
    // Ids of one entry land on the same page, each on its own anchor.
    expect(map["/help/code/activation.device-limit"]).toMatch(
      /#activation\.device-limit$/,
    );
  });

  describe.skipIf(!existsSync(join(dist, "help", "index.html")))(
    "in the built site",
    () => {
      it("writes a redirect page per id that lands on an anchor the target page has", () => {
        for (const id of ids) {
          const html = readFileSync(
            join(dist, "help", "code", id, "index.html"),
            "utf8",
          );
          const url = helpMessageUrl(HELP_MESSAGES, id);
          expect(html, id).toContain(`content="0;url=${url}"`);
          const [path, hash] = url.split("#");
          const page = readFileSync(
            join(dist, path!.replace(/^\/docs\//, ""), "index.html"),
            "utf8",
          );
          expect(page, `${id}: anchor on ${path}`).toContain(`id="${hash}"`);
        }
      });
    },
  );
});
