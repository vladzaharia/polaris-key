import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lintKits, record, scan } from "../bin/kit-lint.mjs";
import { REPO_ROOT } from "../src/config.ts";

const rules = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, "packages/ui-qa/rules/kit-rules.json"),
    "utf8",
  ),
) as {
  kits: Record<string, { roots: string[]; extensions: string[] }>;
  rules: Array<{ id: string; kit: string }>;
};

// One seeded line per rule, in the language of its kit.
const SEED: Record<string, string> = {
  "swiftui-border-shape": ".buttonBorderShape(.roundedRectangle(radius: 12))",
  "swiftui-rtl": ".padding(.left, 8)",
  "swiftui-system-alert": "let a = NSAlert()",
  "swiftui-uppercase": ".textCase(.uppercase)",
  "swiftui-colour-literal": "Color(red: 0.1, green: 0.2, blue: 0.3)",
  "compose-outlined-field": "OutlinedTextField(value, onChange)",
  "compose-legacy-icons": "Icon(Icons.Filled.Info, null)",
  "compose-rtl": "Modifier.absolutePadding(left = 8.dp)",
  "compose-stock-spinner": "CircularProgressIndicator()",
  "compose-system-alert": "AlertDialog(onDismissRequest = {})",
  "godot-system-dialog": "var d := AcceptDialog.new()",
  "godot-checkbox": "var c := CheckBox.new()",
  "godot-rtl": "label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT",
  "godot-uppercase": "label.uppercase = true",
  "godot-colour-literal": 'var c := Color("#ff6a3d")',
  "qt-system-dialog": "QMessageBox.warning(self, 'x', 'y')",
  "qt-checkbox": "box = QCheckBox('Sync')",
  "qt-rtl": "QLabel { margin-left: 4px; }",
  "qt-colour-literal": "label.setStyleSheet('color: #ff6a3d')",
};
const EXT: Record<string, string> = {
  swiftui: ".swift",
  compose: ".kt",
  godot: ".gd",
  qt: ".py",
};

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-lint-"));
  mkdirSync(join(root, "packages/ui-qa/rules"), { recursive: true });
  writeFileSync(
    join(root, "packages/ui-qa/rules/kit-rules.json"),
    JSON.stringify(rules),
  );
  for (const r of rules.rules) {
    const dir = join(root, rules.kits[r.kit]!.roots[0]!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${r.id}${r.id === "qt-rtl" ? ".qss" : EXT[r.kit]}`),
      `${SEED[r.id]}\n`,
    );
  }
  return root;
}

describe("the per-kit source lints (bin/kit-lint.mjs)", () => {
  it("has a seed for every rule, and every seed fails its own rule", () => {
    expect(Object.keys(SEED).sort()).toEqual(
      rules.rules.map((r) => r.id).sort(),
    );
    const hits = scan(seededRoot());
    for (const r of rules.rules)
      expect(
        hits.filter((h) => h.file.includes(r.id)).map((h) => h.rule),
      ).toContain(r.id);
  });

  it("ratchets: recorded debt passes, new debt and stale debt fail", () => {
    const root = seededRoot();
    expect(lintKits(root).findings.length).toBeGreaterThan(0);
    record(root);
    expect(lintKits(root).findings).toEqual([]);
    const f = join(root, rules.kits.compose!.roots[0]!, "compose-rtl.kt");
    writeFileSync(
      f,
      `${SEED["compose-rtl"]}\nText(textAlign = TextAlign.Left)\n`,
    );
    expect(lintKits(root).findings.map((x) => x.rule)).toEqual([
      "compose-rtl",
      "compose-rtl",
    ]);
    writeFileSync(f, "Modifier.padding(start = 8.dp)\n");
    expect(lintKits(root).findings[0]!.detail).toMatch(/stale debt/);
  });

  it("skips generated files and honours a reasoned allow comment", () => {
    const root = seededRoot();
    const dir = join(root, rules.kits.godot!.roots[0]!);
    writeFileSync(
      join(dir, "tokens_generated.gd"),
      "# GENERATED FILE\nvar c := Color8(1, 2, 3)\n",
    );
    writeFileSync(
      join(dir, "allowed_dialog.gd"),
      "var d := AcceptDialog.new() # ui-lint: allow godot-system-dialog the editor plugin's own dialog\n",
    );
    const hits = scan(root, ["godot"]).map((h) => h.file);
    expect(
      hits.some(
        (f) =>
          f.endsWith("tokens_generated.gd") || f.endsWith("allowed_dialog.gd"),
      ),
    ).toBe(false);
  });

  it("is clean on the repository (all hits recorded as debt)", () => {
    expect(lintKits(REPO_ROOT).findings).toEqual([]);
  });
});
