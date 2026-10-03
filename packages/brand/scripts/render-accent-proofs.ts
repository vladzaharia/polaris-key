// Section-accent proof sheets (committed PNGs under preview/proofs/).
//
//   pnpm --filter @polaris-key/brand proofs
//
// One sheet per theme: every section's accent as a swatch (solid, fg, on, subtle and their hex),
// an active nav item (subtle ground, solid marker and icon, fg label), the 48 px Pinned K with that
// section's bit (none on core), a primary badge (fg on subtle) and a solid button (on on solid),
// then the CIEDE2000 matrix between every pair of accents plus the kit gold, the UI signed colour,
// the kit rose and the danger token, with each row's minimum marked. The numbers are the ones
// test/accents.test.ts holds to its floors.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { contrastRatio, deltaE2000 } from "../src/color.js";
import { SERVICE_ACCENTS, THEME_TOKENS } from "../src/generated/tokens.js";
import { markSvg } from "../src/marks/svg.js";
import { BRAND } from "../src/tokens/primitives.js";
import {
  SERVICE_FAMILY,
  SERVICE_IDS,
  SERVICE_LABEL,
  type ServiceId,
  type Theme,
} from "../src/tokens/source.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG, "preview", "proofs");
const FONT = `font-family="Rubik, Helvetica, Arial, sans-serif"`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Place a complete <svg> string at (x, y). */
const place = (svg: string, x: number, y: number) =>
  svg.replace("<svg ", `<svg x="${x}" y="${y}" `);

function sheet(theme: Theme): string {
  const t = THEME_TOKENS[theme];
  const ink = t.text.strong;
  const muted = t.text.muted;
  const A = SERVICE_ACCENTS[theme];
  const rowH = 76;
  const top = 64;
  const width = 1240;
  const out: string[] = [];
  const text = (
    x: number,
    y: number,
    s: string,
    o: { size?: number; bold?: boolean; fill?: string; anchor?: string } = {},
  ) =>
    out.push(
      `<text x="${x}" y="${y}" ${FONT} font-size="${o.size ?? 13}"${o.bold ? ' font-weight="700"' : ""} fill="${o.fill ?? ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}>${esc(s)}</text>`,
    );

  text(24, 34, `Polaris Key section accents, ${theme} theme`, {
    size: 20,
    bold: true,
  });
  text(
    24,
    54,
    "swatch (solid · fg · on · subtle) · nav item · section bit at 48 px · badge · button",
    { fill: muted },
  );

  SERVICE_IDS.forEach((id, i) => {
    const a = A[id];
    const y = top + i * rowH;
    out.push(
      `<rect x="16" y="${y}" width="${width - 32}" height="${rowH - 8}" rx="10" fill="${t.surface.raised}"/>`,
    );
    text(32, y + 28, SERVICE_LABEL[id], { size: 15, bold: true });
    text(32, y + 48, SERVICE_FAMILY[id], { fill: muted });
    // Swatch.
    out.push(
      `<rect x="150" y="${y + 12}" width="44" height="44" rx="8" fill="${a.solid}"/>`,
    );
    text(206, y + 26, `solid ${a.solid}`, { size: 12 });
    text(206, y + 42, `fg ${a.fg}  on ${a.on}`, { size: 12 });
    text(206, y + 58, `subtle ${a.subtle}`, { size: 12, fill: muted });
    // Nav item: subtle ground, solid marker and icon, fg label (the console's active item).
    const nx = 390;
    out.push(
      `<rect x="${nx}" y="${y + 18}" width="200" height="32" rx="6" fill="${a.subtle}"/>`,
      `<rect x="${nx}" y="${y + 22}" width="3" height="24" rx="1.5" fill="${a.solid}"/>`,
      `<rect x="${nx + 14}" y="${y + 26}" width="16" height="16" rx="4" fill="none" stroke="${a.solid}" stroke-width="2"/>`,
      `<circle cx="${nx + 22}" cy="${y + 34}" r="3" fill="${a.solid}"/>`,
    );
    text(nx + 40, y + 39, `${SERVICE_LABEL[id]} item`, { fill: a.fg });
    // The mark with this section's bit (core: none).
    out.push(
      place(
        markSvg({ size: 48, theme, bit: id === "core" ? "none" : id }),
        620,
        y + 10,
      ),
    );
    // Badge (fg on subtle) and button (on on solid), with their contrast.
    const bx = 700;
    out.push(
      `<rect x="${bx}" y="${y + 20}" width="96" height="28" rx="14" fill="${a.subtle}"/>`,
    );
    text(bx + 48, y + 39, "Badge", { fill: a.fg, anchor: "middle" });
    out.push(
      `<rect x="${bx + 108}" y="${y + 18}" width="100" height="32" rx="6" fill="${a.solid}"/>`,
    );
    text(bx + 158, y + 39, "Button", {
      fill: a.on,
      anchor: "middle",
      bold: true,
    });
    text(
      bx + 224,
      y + 30,
      `fg/page ${contrastRatio(a.fg, t.surface.page).toFixed(1)}  fg/subtle ${contrastRatio(a.fg, a.subtle).toFixed(1)}`,
      { size: 12, fill: muted },
    );
    text(
      bx + 224,
      y + 48,
      `on/solid ${contrastRatio(a.on, a.solid).toFixed(1)}  solid/sunken ${contrastRatio(a.solid, t.surface.sunken).toFixed(1)}`,
      { size: 12, fill: muted },
    );
  });

  // The CIEDE2000 matrix.
  const refs: [string, string][] = [
    ["gold", BRAND.gold[theme]],
    ["signed", t.signed.solid],
    ["rose", BRAND.rose[theme]],
    ["danger", t.status.danger.fg],
  ];
  const cols: [string, string][] = [
    ...SERVICE_IDS.map(
      (id) => [SERVICE_LABEL[id], A[id].solid] as [string, string],
    ),
    ...refs,
  ];
  const my = top + SERVICE_IDS.length * rowH + 30;
  text(24, my, "CIEDE2000 between solids (row minimum in bold)", {
    size: 15,
    bold: true,
  });
  const cx0 = 150;
  const cw = 88;
  cols.forEach(([name, hex], j) => {
    out.push(
      `<rect x="${cx0 + j * cw + 8}" y="${my + 14}" width="14" height="14" rx="3" fill="${hex}"/>`,
    );
    text(cx0 + j * cw + 26, my + 26, name, { size: 12 });
  });
  SERVICE_IDS.forEach((id: ServiceId, i) => {
    const y = my + 52 + i * 24;
    text(32, y, SERVICE_LABEL[id], { bold: true });
    const ds = cols.map(([, hex], j) =>
      j === i ? null : deltaE2000(A[id].solid, hex),
    );
    const min = Math.min(...(ds.filter((d) => d !== null) as number[]));
    ds.forEach((d, j) => {
      if (d === null) return text(cx0 + j * cw + 26, y, "·", { fill: muted });
      text(cx0 + j * cw + 26, y, d.toFixed(1), {
        bold: d === min,
        fill: d === min ? ink : muted,
      });
    });
  });
  const height = my + 52 + SERVICE_IDS.length * 24 + 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${t.surface.page}"/>${out.join("")}</svg>`;
}

mkdirSync(OUT, { recursive: true });
for (const theme of ["dark", "light"] as const) {
  const path = join(OUT, `accents-${theme}.png`);
  const png = await sharp(Buffer.from(sheet(theme)), { density: 144 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(path, png);
  console.log(`wrote ${path}`);
}
