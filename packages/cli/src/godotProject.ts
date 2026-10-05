/**
 * Reading a Godot project's listing facts WITHOUT the Godot editor (A-18c; notes/S-15 §7.2), for
 * `pkey listing import --godot <project>`: `project.godot` and `export_presets.cfg` are Godot
 * `ConfigFile` text, parsed here, so CI needs no engine binary.
 *
 * What is read, and from where (S-15 §7.2):
 *
 *   | Listing fact          | Godot setting                                                     |
 *   | --------------------- | ----------------------------------------------------------------- |
 *   | name                  | `application/config/name`                                         |
 *   | localized names       | `application/config/name_localized`                               |
 *   | version               | `application/config/version`; per preset Android `version/name`,  |
 *   |                       | iOS and macOS `application/short_version`, Windows                |
 *   |                       | `application/product_version`                                     |
 *   | bundle ids            | iOS and macOS `application/bundle_identifier`, Android            |
 *   |                       | `package/unique_name`                                             |
 *   | category hints        | Android `package/app_category`, macOS `application/app_category`  |
 *   | copyright             | macOS and Windows `application/copyright`                         |
 *   | company (developer)   | Windows `application/company_name`                                |
 *   | icon master           | iOS `icons/app_store_1024x1024`, falling back to                  |
 *   |                       | `application/config/icon`                                         |
 *   | adaptive icon layers  | Android `launcher_icons/adaptive_{foreground,background,          |
 *   |                       | monochrome}_432x432`                                              |
 *
 * `application/config/description` is NEVER read: it is only the Project Manager's tooltip, not a
 * store description (S-15 §7.2).
 *
 * Icons are resolved to files under the project (a `res://` path that escapes it is refused) and
 * reported with their SHA-256 and, for a PNG, their size; the bytes are not uploaded here, since
 * listing assets are made and uploaded by `pkey listing assets` (A-18d).
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// ── The ConfigFile format ────────────────────────────────────────────────────────────────────

/** A constructor value (`PackedStringArray("a")`, `Vector2(1, 2)`): its type and arguments. */
export interface GodotConstructor {
  $type: string;
  args: GodotValue[];
}

export type GodotValue =
  | string
  | number
  | boolean
  | null
  | GodotValue[]
  | GodotConstructor
  | { [key: string]: GodotValue };

/** A parsed ConfigFile: section → key → value (`""` holds the keys before any section). */
export type GodotConfig = Record<string, Record<string, GodotValue>>;

class ConfigParser {
  private i = 0;
  constructor(
    private readonly src: string,
    private readonly file: string,
  ) {}

  private fail(message: string): never {
    const line = this.src.slice(0, this.i).split("\n").length;
    throw new Error(`${this.file}:${line}: ${message}`);
  }

  private peek(): string {
    return this.src[this.i] ?? "";
  }

  private skipSpace(newlines: boolean): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n"))
        this.i++;
      else if ((c === ";" || c === "#") && newlines) {
        while (this.i < this.src.length && this.peek() !== "\n") this.i++;
      } else return;
    }
  }

  parse(): GodotConfig {
    const out: GodotConfig = { "": {} };
    let section = "";
    for (;;) {
      this.skipSpace(true);
      if (this.i >= this.src.length) return out;
      if (this.peek() === "[") {
        const end = this.src.indexOf("]", this.i);
        const eol = this.src.indexOf("\n", this.i);
        if (end < 0 || (eol >= 0 && end > eol)) this.fail("unclosed section");
        section = this.src.slice(this.i + 1, end).trim();
        out[section] ??= {};
        this.i = end + 1;
        continue;
      }
      const key = this.key();
      this.skipSpace(false);
      if (this.peek() !== "=") this.fail(`expected "=" after ${key}`);
      this.i++;
      this.skipSpace(false);
      out[section]![key] = this.value();
      this.skipSpace(false);
      const c = this.peek();
      if (c === ";" || c === "#") this.skipSpace(true);
      else if (c !== "\n" && c !== "")
        this.fail(`unexpected ${JSON.stringify(c)}`);
    }
  }

  private key(): string {
    if (this.peek() === '"') return this.string();
    const start = this.i;
    while (this.i < this.src.length && !"=\n".includes(this.peek())) this.i++;
    const key = this.src.slice(start, this.i).trim();
    if (!key) this.fail("empty key");
    return key;
  }

  private string(): string {
    const start = this.i;
    this.i++; // the opening quote
    let out = "";
    for (;;) {
      if (this.i >= this.src.length) {
        this.i = start; // name the line the string opened on
        this.fail("unterminated string");
      }
      const c = this.src[this.i++]!;
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.src[this.i++] ?? "";
      switch (e) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "u":
        case "U": {
          const len = e === "u" ? 4 : 6;
          const hex = this.src.slice(this.i, this.i + len);
          if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len)
            this.fail("invalid unicode escape");
          out += String.fromCodePoint(parseInt(hex, 16));
          this.i += len;
          break;
        }
        default:
          out += e; // \" \\ \' and anything else: the character itself
      }
    }
  }

  private list(close: string): GodotValue[] {
    const out: GodotValue[] = [];
    this.skipSpace(true);
    if (this.peek() === close) {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipSpace(true);
      out.push(this.value());
      this.skipSpace(true);
      const c = this.src[this.i++];
      if (c === close) return out;
      if (c !== ",") this.fail(`expected "," or "${close}"`);
      this.skipSpace(true);
      if (this.peek() === close) {
        this.i++;
        return out;
      }
    }
  }

  private value(): GodotValue {
    const c = this.peek();
    if (c === '"') return this.string();
    if ((c === "&" || c === "^") && this.src[this.i + 1] === '"') {
      this.i++;
      return this.string(); // StringName, NodePath
    }
    if (c === "[") {
      this.i++;
      return this.list("]");
    }
    if (c === "{") {
      this.i++;
      const out: Record<string, GodotValue> = {};
      this.skipSpace(true);
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      for (;;) {
        this.skipSpace(true);
        const k = this.value();
        this.skipSpace(true);
        if (this.src[this.i++] !== ":")
          this.fail('expected ":" in a dictionary');
        this.skipSpace(true);
        out[typeof k === "string" ? k : JSON.stringify(k)] = this.value();
        this.skipSpace(true);
        const d = this.src[this.i++];
        if (d === "}") return out;
        if (d !== ",") this.fail('expected "," or "}"');
        this.skipSpace(true);
        if (this.peek() === "}") {
          this.i++;
          return out;
        }
      }
    }
    const num = /^[-+]?(?:\d+\.?\d*(?:e[-+]?\d+)?|\.\d+(?:e[-+]?\d+)?)/i.exec(
      this.src.slice(this.i, this.i + 64),
    );
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(
      this.src.slice(this.i, this.i + 128),
    );
    if (!ident) this.fail(`unexpected ${JSON.stringify(c)}`);
    this.i += ident[0].length;
    const word = ident[0];
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    if (word === "inf" || word === "inf_neg" || word === "nan") return null;
    let type = word;
    if (this.peek() === "[") {
      // A typed container: `Array[String]([...])`, `Dictionary[String, int]({...})`.
      const end = this.src.indexOf("]", this.i);
      if (end < 0) this.fail("unclosed type");
      type += this.src.slice(this.i, end + 1);
      this.i = end + 1;
    }
    this.skipSpace(false);
    if (this.peek() !== "(") this.fail(`unexpected word ${word}`);
    this.i++;
    return { $type: type, args: this.list(")") };
  }
}

/** Parse Godot ConfigFile text (`project.godot`, `export_presets.cfg`). Throws with a line. */
export function parseGodotConfig(text: string, file = "config"): GodotConfig {
  return new ConfigParser(text.replace(/^\uFEFF/, ""), file).parse();
}

// ── The listing facts ────────────────────────────────────────────────────────────────────────

/** One `{platform, value}` fact. */
export interface PlatformValue {
  platform: string;
  value: string;
}

export interface GodotIcon {
  slot:
    | "icon-master"
    | "icon-adaptive-fg"
    | "icon-adaptive-bg"
    | "icon-adaptive-mono";
  /** As the project names it (`res://icon.png`). */
  path: string;
  /** The setting it came from (`icons/app_store_1024x1024`, `application/config/icon`). */
  setting: string;
  sha256?: string;
  width?: number;
  height?: number;
}

/** What `pkey listing import --godot` uploads: the shape the Worker's `godot` source takes. */
export interface GodotListing {
  project: string;
  name?: string;
  nameLocalized?: Record<string, string>;
  copyright?: string;
  company?: string;
  versions: PlatformValue[];
  bundleIds: PlatformValue[];
  categoryHints: PlatformValue[];
  icons: GodotIcon[];
}

export interface GodotRead {
  listing: GodotListing;
  /** The presets read, as `name (platform)`. */
  presets: string[];
  /** What could not be used, for the operator. */
  warnings: string[];
}

/** Godot's export platform names → the platform ids the import uses. */
const PLATFORMS: Readonly<Record<string, string>> = {
  Android: "android",
  iOS: "ios",
  macOS: "macos",
  "Windows Desktop": "windows",
  Linux: "linux",
  "Linux/X11": "linux",
  Web: "web",
  HTML5: "web",
};

/**
 * Android's `package/app_category` enum (`Accessibility, Audio, Game, Image, Maps, News,
 * Productivity, Social, Video, Undefined`), as category hints in the canonical id's words. A hint:
 * the operator confirms the category in the diff, and each store's adapter maps it.
 */
const ANDROID_CATEGORIES: readonly (string | null)[] = [
  "accessibility",
  "music",
  "games",
  "photo-and-video",
  "navigation",
  "news",
  "productivity",
  "social-networking",
  "photo-and-video",
  null,
];

const str = (v: GodotValue | undefined): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** A PNG's width and height from its IHDR chunk, or null. */
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !sig.every((b, i) => bytes[i] === b)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** A `res://` path as a file under `root`, or null when it is not one or escapes the project. */
export function resolveResPath(root: string, res: string): string | null {
  if (!res.startsWith("res://")) return null;
  const rel = res.slice("res://".length);
  const file = path.resolve(root, rel);
  const within = path.relative(root, file);
  if (!within || within.startsWith("..") || path.isAbsolute(within))
    return null;
  return file;
}

/**
 * Read the listing facts of the Godot project at `dir` (a directory holding `project.godot`, or
 * that file). `presets` restricts the export presets read to those names; by default the first
 * preset of each platform is read.
 */
export async function readGodotListing(
  dir: string,
  opts: { presets?: readonly string[] } = {},
): Promise<GodotRead> {
  const root =
    path.basename(dir) === "project.godot"
      ? path.dirname(dir)
      : path.resolve(dir);
  const projectFile = path.join(root, "project.godot");
  let projectText: string;
  try {
    projectText = await readFile(projectFile, "utf8");
  } catch {
    throw new Error(
      `No project.godot in ${root}: --godot takes the Godot project's directory.`,
    );
  }
  const project = parseGodotConfig(projectText, "project.godot");
  const app = project.application ?? {};
  const warnings: string[] = [];
  const listing: GodotListing = {
    project: path.basename(root),
    versions: [],
    bundleIds: [],
    categoryHints: [],
    icons: [],
  };
  const name = str(app["config/name"]);
  if (name) listing.name = name;
  const localized = app["config/name_localized"];
  if (
    localized &&
    typeof localized === "object" &&
    !Array.isArray(localized) &&
    !("$type" in localized)
  ) {
    const names: Record<string, string> = {};
    for (const [locale, v] of Object.entries(localized)) {
      const n = str(v);
      if (n) names[locale] = n;
    }
    if (Object.keys(names).length) listing.nameLocalized = names;
  }
  const version = str(app["config/version"]);
  if (version) listing.versions.push({ platform: "project", value: version });

  // The export presets: the first of each platform, or the named ones.
  const presetsFile = path.join(root, "export_presets.cfg");
  const presetsRead: string[] = [];
  const options: Record<string, Record<string, GodotValue>> = {};
  if (await exists(presetsFile)) {
    const cfg = parseGodotConfig(
      await readFile(presetsFile, "utf8"),
      "export_presets.cfg",
    );
    const sections = Object.keys(cfg)
      .map((s) => /^preset\.(\d+)$/.exec(s))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    for (const m of sections) {
      const preset = cfg[m[0]]!;
      const presetName = str(preset.name) ?? m[0];
      const godotPlatform = str(preset.platform) ?? "";
      const platform = PLATFORMS[godotPlatform];
      if (
        opts.presets?.length
          ? !opts.presets.includes(presetName)
          : platform && options[platform]
      )
        continue;
      if (!platform) {
        warnings.push(
          `preset "${presetName}": platform "${godotPlatform}" is not read`,
        );
        continue;
      }
      if (options[platform]) {
        warnings.push(
          `preset "${presetName}": a ${platform} preset was already read`,
        );
        continue;
      }
      options[platform] = cfg[`${m[0]}.options`] ?? {};
      presetsRead.push(`${presetName} (${godotPlatform})`);
    }
    for (const p of opts.presets ?? [])
      if (!presetsRead.some((r) => r.startsWith(`${p} (`)))
        warnings.push(`no export preset named "${p}"`);
  } else if (opts.presets?.length) {
    throw new Error(
      `--preset was given but ${root} has no export_presets.cfg.`,
    );
  }

  const opt = (platform: string, key: string) => str(options[platform]?.[key]);
  for (const [platform, key] of [
    ["android", "version/name"],
    ["ios", "application/short_version"],
    ["macos", "application/short_version"],
    ["windows", "application/product_version"],
  ] as const) {
    const v = opt(platform, key);
    if (v) listing.versions.push({ platform, value: v });
  }
  for (const [platform, key] of [
    ["ios", "application/bundle_identifier"],
    ["macos", "application/bundle_identifier"],
    ["android", "package/unique_name"],
  ] as const) {
    const v = opt(platform, key);
    if (!v) continue;
    if (v.includes("$"))
      warnings.push(
        `${platform} ${key} "${v}" is a template (it holds $), not an id`,
      );
    else listing.bundleIds.push({ platform, value: v });
  }
  const macCategory = opt("macos", "application/app_category");
  if (macCategory)
    listing.categoryHints.push({ platform: "macos", value: macCategory });
  const androidCategory = options.android?.["package/app_category"];
  if (typeof androidCategory === "number") {
    const hint = ANDROID_CATEGORIES[androidCategory];
    if (hint) listing.categoryHints.push({ platform: "android", value: hint });
  }
  const copyright =
    opt("macos", "application/copyright") ??
    opt("windows", "application/copyright");
  if (copyright) listing.copyright = copyright;
  const company = opt("windows", "application/company_name");
  if (company) listing.company = company;

  // Icons: the 1024² master (iOS's App Store icon, else the project icon) and Android's layers.
  const master =
    (opt("ios", "icons/app_store_1024x1024") && {
      setting: "icons/app_store_1024x1024",
      path: opt("ios", "icons/app_store_1024x1024")!,
    }) ||
    (opt("ios", "icons/icon_1024x1024") && {
      setting: "icons/icon_1024x1024",
      path: opt("ios", "icons/icon_1024x1024")!,
    }) ||
    (str(app["config/icon"]) && {
      setting: "application/config/icon",
      path: str(app["config/icon"])!,
    }) ||
    null;
  const wanted: Array<{
    slot: GodotIcon["slot"];
    setting: string;
    path: string;
  }> = [];
  if (master) wanted.push({ slot: "icon-master", ...master });
  for (const [slot, layer] of [
    ["icon-adaptive-fg", "foreground"],
    ["icon-adaptive-bg", "background"],
    ["icon-adaptive-mono", "monochrome"],
  ] as const) {
    const setting = `launcher_icons/adaptive_${layer}_432x432`;
    const p = opt("android", setting);
    if (p) wanted.push({ slot, setting, path: p });
  }
  for (const w of wanted) {
    const icon: GodotIcon = { slot: w.slot, path: w.path, setting: w.setting };
    const file = resolveResPath(root, w.path);
    if (!file) {
      warnings.push(
        `${w.setting} "${w.path}" is not a res:// path inside the project; it is reported without a digest`,
      );
    } else if (!(await exists(file))) {
      warnings.push(`${w.setting} "${w.path}" does not exist in the project`);
    } else {
      const bytes = new Uint8Array(await readFile(file));
      icon.sha256 = createHash("sha256").update(bytes).digest("hex");
      const size = pngSize(bytes);
      if (size) {
        icon.width = size.width;
        icon.height = size.height;
      }
    }
    listing.icons.push(icon);
  }
  return { listing, presets: presetsRead, warnings };
}
