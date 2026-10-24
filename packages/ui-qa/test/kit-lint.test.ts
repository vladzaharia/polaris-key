import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { lintKits, record, relPosix, scan } from "../bin/kit-lint.mjs";
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
  "terminal-python-rtl": "label = name.ljust(20)",
  "terminal-python-escape": 'print("\\x1b[31mred\\x1b[0m")',
  "terminal-python-colour-literal": 'ACCENT = "#ff6a3d"',
  "terminal-python-stock-spinner": 'with console.status("Working"):',
  "react-rtl": "const s = { marginLeft: 8 };",
  "react-system-dialog": "if (window.confirm('Remove?')) remove();",
  "react-uppercase": 'const s = { textTransform: "uppercase" };',
  "react-colour-literal": 'const s = { color: "#ff6a3d" };',
  "react-px-font": 'const s = { fontSize: "13px" };',
  "terminal-raw-escape": "out.write(`\\x1b[36m${name}\\x1b[39m`);",
  // Design language (UK-55): one seeded line per rule and kit.
  "swiftui-spacing-off-scale": ".padding(.horizontal, 20)",
  "swiftui-weights": "Text(title).fontWeight(.heavy)",
  "swiftui-polaris-mark": "PolarisMark(size: 40)",
  "swiftui-catalog-string": 'Text("Sign in")',
  "swiftui-link-validation": "openURL(link)",
  "swiftui-px-font": ".font(.system(size: 14))",
  "compose-spacing-off-scale": "Modifier.padding(horizontal = 16.dp)",
  "compose-weights": "style = TextStyle(fontWeight = FontWeight.Bold)",
  "compose-polaris-mark": "PolarisMark()",
  "compose-catalog-string": 'Text("Sign in")',
  "compose-link-validation": "uriHandler.openUri(link)",
  "compose-px-font":
    "CompositionLocalProvider(LocalDensity provides Density(2f)) {}",
  "godot-spacing-off-scale":
    'box.add_theme_constant_override("margin_left", 12)',
  "godot-weights": 'label.add_theme_font_override("font", theme.bold_font)',
  "godot-polaris-mark": "var k := PINNED_K_DARK",
  "godot-catalog-string": 'label.text = "Sign in"',
  "godot-link-validation": "OS.shell_open(url)",
  "godot-px-font": 'label.add_theme_font_size_override("font_size", 14)',
  "qt-spacing-off-scale": "layout.setSpacing(12)",
  "qt-weights": "font.setBold(True)",
  "qt-polaris-mark": "icon = pinned_k",
  "qt-catalog-string": "label = QLabel('Sign in')",
  "qt-link-validation": "QDesktopServices.openUrl(url)",
  "qt-px-font": "QLabel { font-size: 14px; }",
  "react-spacing-off-scale": "const s = { padding: 12 };",
  "react-weights": "const s = { fontWeight: 700 };",
  "react-polaris-mark": "const m = <PolarisMark size={24} />;",
  "react-catalog-string": "const p = <p>Sign in again</p>;",
  "react-link-validation": "window.open(url);",
  "terminal-node-catalog-string": 'io.print("Waiting");',
  "terminal-node-link-validation": 'spawn("open", [url]);',
  "terminal-python-catalog-string": 'print("Waiting")',
  "terminal-python-link-validation": "webbrowser.open(url)",
  "terminal-stock-prompt": "const rl = createInterface({ input, output });",
  "terminal-console": 'console.log("Activated");',
  "terminal-uppercase": "const title = heading.toUpperCase();",
};
// File rules (DL9 initial focus): a screen file that never sets focus. The path decides the rule.
const FILE_SEED: Record<string, { file: string; text: string }> = {
  "swiftui-initial-focus": {
    file: "sdks/swift/Sources/PolarisKeyUI/Kit/Screens/GateScreens.swift",
    text: "struct Gate: View { var body: some View { Text(x) } }",
  },
  "compose-initial-focus": {
    file: "sdks/kotlin/ui/src/commonMain/kotlin/im/plrs/key/ui/PolarisGate.kt",
    text: "@Composable fun Gate() { Button(onClick = {}) {} }",
  },
  "godot-initial-focus": {
    file: "sdks/godot/addons/polaris_key/ui/gate/pkey_gate.gd",
    text: "extends Control\nfunc _ready() -> void:\n\tpass",
  },
  "qt-initial-focus": {
    file: "sdks/python/src/polaris_key/ui/qt/gate.py",
    text: "class Gate:\n    pass",
  },
};
const EXT: Record<string, string> = {
  swiftui: ".swift",
  compose: ".kt",
  godot: ".gd",
  qt: ".py",
  react: ".tsx",
  "terminal-python": ".py",
  "terminal-node": ".ts",
};

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-lint-"));
  mkdirSync(join(root, "packages/ui-qa/rules"), { recursive: true });
  writeFileSync(
    join(root, "packages/ui-qa/rules/kit-rules.json"),
    JSON.stringify(rules),
  );
  for (const r of rules.rules) {
    const fileSeed = FILE_SEED[r.id];
    if (fileSeed) {
      mkdirSync(dirname(join(root, fileSeed.file)), { recursive: true });
      writeFileSync(join(root, fileSeed.file), `${fileSeed.text}\n`);
      continue;
    }
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
  it("keys files by forward-slash paths on Windows, so theme excludes still match", () => {
    const rel = relPosix(
      "C:\\a\\repo",
      "C:\\a\\repo\\sdks\\godot\\addons\\polaris_key\\ui\\theme\\pkey_ui_theme.gd",
      win32,
    );
    expect(rel).toBe("sdks/godot/addons/polaris_key/ui/theme/pkey_ui_theme.gd");
    const excludes = (
      rules.rules as Array<{ id: string; exclude?: string[] }>
    ).filter((r) => r.exclude?.includes("/ui/theme/"));
    expect(excludes.map((r) => r.id).sort()).toEqual([
      "godot-checkbox",
      "godot-colour-literal",
    ]);
    for (const r of excludes)
      expect(r.exclude!.some((x) => new RegExp(x).test(rel))).toBe(true);
  });

  it("has a seed for every rule, and every seed fails its own rule", () => {
    expect([...Object.keys(SEED), ...Object.keys(FILE_SEED)].sort()).toEqual(
      rules.rules.map((r) => r.id).sort(),
    );
    const hits = scan(seededRoot());
    for (const r of rules.rules)
      expect(
        hits
          .filter((h) => FILE_SEED[r.id] || h.file.includes(r.id))
          .map((h) => h.rule),
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
    writeFileSync(f, "Modifier.padding(start = Space.s2)\n");
    expect(lintKits(root).findings[0]!.detail).toMatch(/stale debt/);
  });

  it("react-uppercase flags an upper-cased string, not a capitalised first letter", () => {
    const root = seededRoot();
    const dir = join(root, rules.kits.react!.roots[0]!);
    writeFileSync(
      join(dir, "caps.tsx"),
      "const a = w.charAt(0).toUpperCase() + w.slice(1);\nconst b = title.toUpperCase();\n",
    );
    const hits = scan(root, ["react"]).filter((h) =>
      h.file.endsWith("caps.tsx"),
    );
    expect(hits.map((h) => h.line)).toEqual([2]);
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

  it("covers the eight design-language rules in every kit that can see them", () => {
    const dl = rules.rules.filter((r) => (r as { dl?: string }).dl);
    const byRule = new Map<string, Set<string>>();
    for (const r of dl) {
      const id = (r as { rule?: string }).rule!;
      byRule.set(id, (byRule.get(id) ?? new Set()).add(r.kit));
    }
    expect([...byRule.keys()].sort()).toEqual([
      "catalog-string",
      "initial-focus",
      "link-validation",
      "polaris-mark",
      "px-font",
      "spacing-off-scale",
      "weights",
    ]);
    // Every native kit has each rule it can see (refusal-styling is a runtime walk, not a pattern).
    for (const kit of ["swiftui", "compose", "godot", "qt"])
      for (const id of byRule.keys())
        if (id !== "link-validation" || kit !== "qt" || true)
          expect(byRule.get(id)!.has(kit), `${kit} ${id}`).toBe(true);
  });

  it("spares the token, catalog and validated forms the rules allow", () => {
    const root = seededRoot();
    const clean: Record<string, string> = {
      swiftui: [
        ".padding(Space.s4)",
        "VStack(spacing: Space.s2) {",
        "Text(copy.title).fontWeight(.semibold)",
        "Text(verbatim: model.name)",
        ".font(.system(.body))",
        "// .bold() is banned, says this comment",
      ].join("\n"),
      compose: [
        "Modifier.padding(horizontal = Space.s4)",
        "Modifier.padding(0.dp)",
        "fontWeight = FontWeight.SemiBold",
        "Text(copy.title)",
        'Text("$name")',
      ].join("\n"),
      godot: [
        'box.add_theme_constant_override("margin_left", Space.S4)',
        'label.text = tr("gate.title")',
        "# OS.shell_open is validated in the opener",
        "var a = _exp[_log[a] + _log[b]]",
      ].join("\n"),
      qt: [
        "layout.setSpacing(Theme.space4)",
        "font.pixelSize: Theme.typeButton.size * control.scale_",
        "text: copy.title",
      ].join("\n"),
    };
    for (const [kit, text] of Object.entries(clean)) {
      const dir = join(root, rules.kits[kit]!.roots[0]!);
      writeFileSync(join(dir, `clean${EXT[kit]}`), `${text}\n`);
    }
    const hits = scan(root).filter((h) => h.file.includes("/clean."));
    expect(hits.map((h) => `${h.rule} ${h.text}`)).toEqual([]);
  });

  it("a file rule passes a screen that sets focus and honours a reasoned allow", () => {
    const root = seededRoot();
    for (const [id, seed] of Object.entries(FILE_SEED)) {
      const ok: Record<string, string> = {
        "swiftui-initial-focus": "@FocusState var f: Bool",
        "compose-initial-focus": "focusRequester.requestFocus()",
        "godot-initial-focus": "func _initial_focus() -> void:\n\tpass",
        "qt-initial-focus": "self.widget.setFocus()",
      };
      writeFileSync(join(root, seed.file), `${seed.text}\n${ok[id]}\n`);
    }
    expect(
      scan(root)
        .filter((h) => h.rule.endsWith("-initial-focus"))
        .map((h) => h.rule),
    ).toEqual([]);
    const f = join(root, FILE_SEED["godot-initial-focus"]!.file);
    writeFileSync(
      f,
      "# ui-lint: allow godot-initial-focus a pure container, its host focuses\nextends Control\n",
    );
    expect(scan(root).filter((h) => h.rule === "godot-initial-focus")).toEqual(
      [],
    );
  });

  it("is clean on the repository (all hits recorded as debt)", () => {
    expect(lintKits(REPO_ROOT).findings).toEqual([]);
  });
});
