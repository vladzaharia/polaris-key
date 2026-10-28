import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { blocker } from "../../src/ui/confirmReasons.js";

/**
 * A disabled confirm says why. Every JSX element in `src/` that passes `confirmDisabled` also
 * passes `confirmDisabledReason`: a `ConfirmDialog`, or a wrapper that forwards to one. A source
 * scan reaches the dialogs a render sweep would have to open one by one (most need a record, a
 * step-up or a store connection first).
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

/** Elements that pass `confirmDisabled` without `confirmDisabledReason`, as `file:line`. */
function missingReasons(source: string, name = "x.tsx"): string[] {
  const sf = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxAttributes(n)) {
      // A spread of `confirmBlocked(...)` or of a `...Gate` value carries both props.
      const names = n.properties.flatMap((p) =>
        ts.isJsxAttribute(p)
          ? [p.name.getText(sf)]
          : /confirmBlocked\(|Gate$/.test(p.expression.getText(sf))
            ? ["confirmDisabled", "confirmDisabledReason"]
            : [],
      );
      if (
        names.includes("confirmDisabled") &&
        !names.includes("confirmDisabledReason")
      )
        out.push(
          `${name}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
        );
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("confirmDisabledReason", () => {
  it("is passed wherever confirmDisabled is", () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(100);
    const missing = all.flatMap((f) =>
      missingReasons(readFileSync(f, "utf8"), relative(SRC, f)),
    );
    expect(missing).toEqual([]);
  });

  it("the scan itself catches a caller without a reason", () => {
    expect(
      missingReasons("const a = <ConfirmDialog confirmDisabled={x} />;"),
    ).toHaveLength(1);
    expect(
      missingReasons(
        'const a = <ConfirmDialog confirmDisabled={x} confirmDisabledReason="Why" />;',
      ),
    ).toEqual([]);
  });

  it("blocker names the first step that blocks, in reading order", () => {
    expect(blocker([false, "a"], [true, "b"], [true, "c"])).toBe("b");
    expect(blocker([false, "a"])).toBeUndefined();
  });
});
