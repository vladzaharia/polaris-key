// `headers.json`: the client metadata header values (§5.2), checked against the vocabulary in
// `conformance/parity/enums.json`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./common.js";
import { refFoldAscii } from "./reference/headers.js";

// ── Client metadata header values (headers.json) ─────────────────────────────
// WIRE-CONTRACT-V3 §5.2. One row per SPELLING a runtime reports, not per SDK: every SDK and the
// Worker run every row through the same lookup (fold ASCII A–Z, no trimming, own entries only),
// so rows that describe one machine agree by construction and a later SDK reuses them without a
// corpus change. `expect: null` means the spelling has no value: an SDK omits the header, and the
// Worker stores `raw` as sent (nothing, for an empty `raw`).
//
// THE ROWS ARE THE TABLES. `PLATFORM_SPELLINGS` / `ARCH_SPELLINGS` (`@polaris-key/protocol/core`,
// generated into every SDK) hold exactly the folded `raw` of the non-null rows, and every runner
// asserts its own table equals the map derived from them — so a spelling cannot enter or leave a
// table without a case here. The self-check below ties each canonical value to
// conformance/parity/enums.json, so adding a vocabulary value needs a corpus case (and a plan).

interface HeaderCase {
  id: string;
  description: string;
  raw: string;
  expect: string | null;
}

const PLATFORM_CASES: HeaderCase[] = [
  {
    id: "rust-macos",
    description:
      "Rust std::env::consts::OS on macOS; the canonical value maps to itself.",
    raw: "macos",
    expect: "macos",
  },
  {
    id: "godot-swift-macos",
    description: "Godot OS.get_name() and Swift's os(macOS) token.",
    raw: "macOS",
    expect: "macos",
  },
  {
    id: "node-darwin",
    description:
      "Node os.platform() on macOS; the old Node, Python and Swift header.",
    raw: "darwin",
    expect: "macos",
  },
  {
    id: "python-darwin",
    description: "Python platform.system() on macOS.",
    raw: "Darwin",
    expect: "macos",
  },
  {
    id: "swift-mac-catalyst",
    description:
      "Swift's targetEnvironment(macCatalyst): a Catalyst build sends macos.",
    raw: "macCatalyst",
    expect: "macos",
  },
  {
    id: "swift-legacy-ios",
    description: "The old Swift header; the canonical value maps to itself.",
    raw: "ios",
    expect: "ios",
  },
  {
    id: "godot-swift-python-ios",
    description:
      "Godot OS.get_name(), Swift's os(iOS) and Python 3.13+ on iOS.",
    raw: "iOS",
    expect: "ios",
  },
  {
    id: "python-ipados",
    description: "Python 3.13+ platform.system() on an iPad: iPadOS is ios.",
    raw: "iPadOS",
    expect: "ios",
  },
  {
    id: "node-android",
    description:
      "Node os.platform() on Android; the canonical value maps to itself.",
    raw: "android",
    expect: "android",
  },
  {
    id: "godot-python-android",
    description: "Godot OS.get_name() and Python 3.13+ on Android.",
    raw: "Android",
    expect: "android",
  },
  {
    id: "python-legacy-windows",
    description:
      "The old Python header (platform.system().lower()); the canonical value maps to itself.",
    raw: "windows",
    expect: "windows",
  },
  {
    id: "python-godot-swift-windows",
    description:
      "Python platform.system(), Godot OS.get_name() and Swift's os(Windows).",
    raw: "Windows",
    expect: "windows",
  },
  {
    id: "node-win32",
    description:
      "Node os.platform() on Windows; the old Node and Swift header.",
    raw: "win32",
    expect: "windows",
  },
  {
    id: "node-linux",
    description:
      "Node os.platform() on Linux; the canonical value maps to itself.",
    raw: "linux",
    expect: "linux",
  },
  {
    id: "python-godot-linux",
    description:
      "Python platform.system(), Godot OS.get_name() and Swift's os(Linux).",
    raw: "Linux",
    expect: "linux",
  },
  {
    id: "ascii-fold-upper-case-linux",
    description:
      "Folding is ASCII A-Z only: a Turkish-locale lowercase would give a dotless i and miss.",
    raw: "LINUX",
    expect: "linux",
  },
  {
    id: "react-web",
    description:
      "The React browser adapter; the canonical value maps to itself.",
    raw: "web",
    expect: "web",
  },
  {
    id: "godot-web-export",
    description: "Godot OS.get_name() in a web export.",
    raw: "Web",
    expect: "web",
  },
  {
    id: "react-legacy-browser",
    description: "The old React header.",
    raw: "browser",
    expect: "web",
  },
  {
    id: "python-freebsd",
    description:
      "Python platform.system() on FreeBSD: no value, so the header is omitted.",
    raw: "FreeBSD",
    expect: null,
  },
  {
    id: "node-freebsd",
    description: "Node os.platform() on FreeBSD: no value.",
    raw: "freebsd",
    expect: null,
  },
  {
    id: "node-sunos",
    description: "Node os.platform() on illumos and Solaris: no value.",
    raw: "sunos",
    expect: null,
  },
  {
    id: "node-cygwin",
    description: "Node os.platform() under Cygwin: no value.",
    raw: "cygwin",
    expect: null,
  },
  {
    id: "pyodide-emscripten",
    description: "Python platform.system() under Pyodide: no value.",
    raw: "Emscripten",
    expect: null,
  },
  {
    id: "swift-godot-visionos",
    description:
      "Swift's os(visionOS) and Godot OS.get_name() on visionOS (headersVersion 2: no value before).",
    raw: "visionOS",
    expect: "visionos",
  },
  {
    id: "swift-tvos",
    description: "Swift's os(tvOS) (headersVersion 2: no value before).",
    raw: "tvOS",
    expect: "tvos",
  },
  {
    id: "swift-legacy-unknown",
    description: "The old Swift fallback: never sent, and no value.",
    raw: "unknown",
    expect: null,
  },
  {
    id: "python-undeterminable-empty",
    description:
      "Python platform.system() when the OS cannot be determined: no value, and the Worker treats an empty header as absent.",
    raw: "",
    expect: null,
  },
  {
    id: "no-trimming-leading-space",
    description: "The lookup does not trim.",
    raw: " linux",
    expect: null,
  },
  {
    id: "prototype-constructor",
    description: "The lookup reads the table's own entries only.",
    raw: "constructor",
    expect: null,
  },
  {
    id: "prototype-proto",
    description: "The lookup reads the table's own entries only.",
    raw: "__proto__",
    expect: null,
  },
  {
    id: "canonical-tvos",
    description: "The canonical value maps to itself.",
    raw: "tvos",
    expect: "tvos",
  },
  {
    id: "canonical-visionos",
    description: "The canonical value maps to itself.",
    raw: "visionos",
    expect: "visionos",
  },
  {
    id: "canonical-watchos",
    description: "The canonical value maps to itself.",
    raw: "watchos",
    expect: "watchos",
  },
  {
    id: "swift-watchos",
    description: "Swift's os(watchOS) token.",
    raw: "watchOS",
    expect: "watchos",
  },
];

const ARCH_CASES: HeaderCase[] = [
  {
    id: "python-swift-godot-x86-64",
    description:
      "Python platform.machine() on Linux and macOS, Swift's arch(x86_64), Godot and Rust; the canonical value maps to itself.",
    raw: "x86_64",
    expect: "x86_64",
  },
  {
    id: "ascii-fold-upper-case-x86-64",
    description: "Folding is ASCII A-Z only.",
    raw: "X86_64",
    expect: "x86_64",
  },
  {
    id: "node-x64",
    description: "Node os.arch() and .NET; the old Node header.",
    raw: "x64",
    expect: "x86_64",
  },
  {
    id: "jvm-amd64",
    description: "The JVM's os.arch.",
    raw: "amd64",
    expect: "x86_64",
  },
  {
    id: "python-windows-amd64",
    description: "Python platform.machine() on Windows; the old Python header.",
    raw: "AMD64",
    expect: "x86_64",
  },
  {
    id: "node-swift-godot-arm64",
    description:
      "Node os.arch(), Python on macOS, Swift's arch(arm64) and Godot; the canonical value maps to itself.",
    raw: "arm64",
    expect: "arm64",
  },
  {
    id: "python-windows-arm64",
    description: "Python platform.machine() on Windows on Arm.",
    raw: "ARM64",
    expect: "arm64",
  },
  {
    id: "python-linux-aarch64",
    description:
      "Python platform.machine() on Linux, Rust and the JVM; the old Python header.",
    raw: "aarch64",
    expect: "arm64",
  },
  {
    id: "android-abi-arm64-v8a",
    description: "An Android ABI name.",
    raw: "arm64-v8a",
    expect: "arm64",
  },
  {
    id: "canonical-armv7",
    description: "The canonical value maps to itself.",
    raw: "armv7",
    expect: "armv7",
  },
  {
    id: "python-armv7l",
    description: "Python platform.machine() on a 32-bit Arm Linux board.",
    raw: "armv7l",
    expect: "armv7",
  },
  {
    id: "linux-armv8l",
    description: "A 32-bit userland on a 64-bit Arm kernel.",
    raw: "armv8l",
    expect: "armv7",
  },
  {
    id: "node-arm",
    description:
      "Node os.arch(), Rust and .NET on 32-bit Arm, whose official builds are ARMv7.",
    raw: "arm",
    expect: "armv7",
  },
  {
    id: "godot-arm32",
    description: "Godot Engine.get_architecture_name() on 32-bit Arm.",
    raw: "arm32",
    expect: "armv7",
  },
  {
    id: "android-abi-armeabi-v7a",
    description: "An Android ABI name.",
    raw: "armeabi-v7a",
    expect: "armv7",
  },
  {
    id: "godot-rust-wasm32",
    description:
      "Godot's web export and Rust; the canonical value maps to itself. A browser's JavaScript has no arch and sends none.",
    raw: "wasm32",
    expect: "wasm32",
  },
  {
    id: "node-ia32",
    description:
      "Node os.arch() on 32-bit x86: no value, so the header is omitted.",
    raw: "ia32",
    expect: null,
  },
  {
    id: "dotnet-rust-x86",
    description: ".NET, Rust and Android on 32-bit x86: no value.",
    raw: "x86",
    expect: null,
  },
  {
    id: "python-i686",
    description: "Python platform.machine() on 32-bit x86: no value.",
    raw: "i686",
    expect: null,
  },
  {
    id: "godot-x86-32",
    description:
      "Godot Engine.get_architecture_name() on 32-bit x86: no value.",
    raw: "x86_32",
    expect: null,
  },
  {
    id: "python-armv6l",
    description:
      "Python platform.machine() on ARMv6, where armv7 builds do not run: no value.",
    raw: "armv6l",
    expect: null,
  },
  {
    id: "riscv64",
    description: "RISC-V: no value until a spelling and a case add one.",
    raw: "riscv64",
    expect: null,
  },
  {
    id: "wasm64",
    description: "64-bit WebAssembly: no value.",
    raw: "wasm64",
    expect: null,
  },
  {
    id: "watchos-arm64-32",
    description: "watchOS's arm64_32: no value.",
    raw: "arm64_32",
    expect: null,
  },
  {
    id: "artifact-universal",
    description: "An artifact value, never a header value.",
    raw: "universal",
    expect: null,
  },
  {
    id: "artifact-any",
    description: "An artifact value, never a header value.",
    raw: "any",
    expect: null,
  },
  {
    id: "unknown",
    description: "No value.",
    raw: "unknown",
    expect: null,
  },
  {
    id: "empty",
    description: "No value, and the Worker treats an empty header as absent.",
    raw: "",
    expect: null,
  },
  {
    id: "no-trimming-trailing-space",
    description: "The lookup does not trim.",
    raw: "x86_64 ",
    expect: null,
  },
  {
    id: "prototype-constructor",
    description: "The lookup reads the table's own entries only.",
    raw: "constructor",
    expect: null,
  },
  {
    id: "prototype-proto",
    description: "The lookup reads the table's own entries only.",
    raw: "__proto__",
    expect: null,
  },
];

/** The canonical vocabulary, read from the registry the generated constants come from. */
function readParityEnum(name: string): string[] {
  const enums = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "conformance", "parity", "enums.json"),
      "utf8",
    ),
  ) as { enums: { name: string; values: string[] }[] };
  const found = enums.enums.find((e) => e.name === name);
  if (!found) throw new Error(`conformance/parity/enums.json has no ${name}`);
  return found.values;
}

function checkHeaderSection(
  section: string,
  rows: HeaderCase[],
  vocabulary: string[],
): void {
  const fail = (id: string, why: string): never => {
    throw new Error(
      `corpus self-check failed: headers/${section}/${id}: ${why}`,
    );
  };
  const ids = new Set<string>();
  const byFolded = new Map<string, string | null>();
  for (const row of rows) {
    if (ids.has(row.id)) fail(row.id, "duplicate id");
    ids.add(row.id);
    const folded = refFoldAscii(row.raw);
    if (byFolded.has(folded) && byFolded.get(folded) !== row.expect)
      fail(
        row.id,
        `folds to "${folded}" like another row, with another expect`,
      );
    byFolded.set(folded, row.expect);
    if (row.expect === null) continue;
    if (!vocabulary.includes(row.expect))
      fail(row.id, `"${row.expect}" is not a value of the enum`);
    // The key alphabet keeps Swift's Dictionary lookup (canonical equivalence) exact: no other
    // scalar sequence is canonically equivalent to such a key.
    if (!/^[a-z0-9_-]+$/.test(folded))
      fail(row.id, `table key "${folded}" is outside [a-z0-9_-]`);
  }
  for (const value of vocabulary)
    if (!rows.some((r) => r.raw === value && r.expect === value))
      fail(value, "no identity row (raw equal to the value)");
}

export function buildHeadersCorpus(): unknown {
  checkHeaderSection(
    "platformCases",
    PLATFORM_CASES,
    readParityEnum("platform"),
  );
  checkHeaderSection("archCases", ARCH_CASES, readParityEnum("arch"));
  return {
    headersVersion: 2,
    description:
      "Client metadata header values (WIRE-CONTRACT-V3 §5.2). Each row is one spelling an OS or runtime reports (`raw`) and its canonical `X-PKey-Platform` (`platformCases`) or `X-PKey-Arch` (`archCases`) value. A runner looks `raw` up after ASCII case folding (A-Z only, never a locale-dependent lowercase), with no trimming, reading the table's own entries only. `expect: null` means the spelling has no value: an SDK omits the header rather than inventing one, and the Worker stores `raw` as sent (nothing, for an empty `raw`). The rows are the tables: `PLATFORM_SPELLINGS` and `ARCH_SPELLINGS` (`@polaris-key/protocol/core`, generated into every SDK) hold exactly the folded `raw` of the non-null rows, and every runner asserts that its table equals the map derived from them. Append-only: a new spelling (a row plus a table entry) keeps `headersVersion`; a changed row, or a change to folding or lookup, bumps it.",
    platformCases: PLATFORM_CASES,
    archCases: ARCH_CASES,
  };
}
