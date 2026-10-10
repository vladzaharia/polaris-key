import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { it } from "vitest";
import { copyStrings } from "./copyLint.test";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
it("inv", () => {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const pats: [string, RegExp][] = Object.entries(
    KIT_COPY_EN as Record<string, any>,
  )
    .filter(([k, v]) => {
      const val = typeof v === "string" ? v : v.value;
      return (
        val.replace(/\{[^}]*\}/g, "").trim().length >= 5 &&
        !/^(cli|a11y)\./.test(k)
      );
    })
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : v.value;
      const esc = norm(val)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\{[^}]*\\\}/g, ".+");
      return [k, new RegExp("^" + esc + "$")];
    });
  const out: string[] = [];
  for (const f of walk(join(__dirname, "../src/portal")))
    for (const s of copyStrings(readFileSync(f, "utf8"), f)) {
      const hit = pats.filter(([k, r]) => r.test(s.text)).map(([k]) => k);
      if (hit.length)
        out.push(
          `${relative(join(__dirname, "../src/portal"), f)}:${s.line}\t${s.text}\t${hit.join(",")}`,
        );
    }
  require("node:fs").writeFileSync("/tmp/p36/inv.txt", out.join("\n"));
});
