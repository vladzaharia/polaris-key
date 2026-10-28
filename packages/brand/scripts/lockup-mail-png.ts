// The Polaris Locker lockup as 2x PNGs for the Worker's branded emails (mail clients do not render
// SVG reliably). Rendered from `lockupSvg({ kind: "locker", trim: true })`, so the PNG is the same
// re-laid lockup as the web (mark 1.5 x the cap height, BRAND.md §1.4); the email shows it 26 px
// tall (214 px wide) from a 52 px raster.
//
//   pnpm --filter @polaris-key/brand lockup-mail-png
//
// Written to lockups/mail/ (not a `pnpm gen brand` output: the raster depends on the renderer, so
// test/lockup-mail-png.test.ts pins size and aspect, not bytes). The kit's own
// locker-horizontal-*-640.png stay where they are: mail already sent still loads them.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { lockupSvg } from "../src/marks/svg.js";

export const MAIL_LOCKUP_HEIGHT = 52;
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "lockups",
  "mail",
);
mkdirSync(OUT, { recursive: true });
for (const theme of ["light", "dark"] as const) {
  const svg = lockupSvg({
    kind: "locker",
    layout: "horizontal",
    theme,
    trim: true,
    height: MAIL_LOCKUP_HEIGHT,
    title: "",
  });
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(OUT, `locker-lockup-${theme}-2x.png`), png);
  console.log(`wrote lockups/mail/locker-lockup-${theme}-2x.png`);
}
