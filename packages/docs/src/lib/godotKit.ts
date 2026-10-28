/**
 * The Godot kit's tab on a `build/ui/components/` page, from the addon's own source.
 *
 * A component page's "Godot" tab names GDScript classes, scene files and view-model ids. None of
 * them is typed here: the registry holds file stems under `sdks/godot/addons/polaris_key/ui/` and
 * this module reads each file's `class_name`, so a renamed class shows up in the docs at the next
 * build, and a stem that no longer exists fails it. The models come from `model/models.gd`'s
 * MODELS table and the theme type variations from `theme/pkey_ui_theme.gd`'s VARIATIONS, the same
 * way.
 *
 * test/godotKit.test.ts holds the rest: every class in the addon that is a view or a controller is
 * claimed by a component here or listed in INTERNAL with a reason, so a new class forces a docs
 * decision, and every component page with a registered component carries its tab (and no other
 * page carries one).
 *
 * This module is plain Node (`node:fs`): Astro runs a page's frontmatter in Node at build time, and
 * vitest imports it directly.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./repo";

/** The kit's folder, relative to the repository root. */
export const UI_DIR = "sdks/godot/addons/polaris_key/ui";

/** What a scene's path is relative to, as a game writes it. */
export const UI_RES = "res://addons/polaris_key/ui/";

/**
 * What the kit has for one catalog component. Stems are relative to the kit folder, without an
 * extension: `activation/pkey_activation_panel` is the view script `pkey_activation_panel.gd` and
 * the scene `pkey_activation_panel.tscn` beside it.
 */
export interface GodotComponent {
  /** The scene of the screen that shows this component, when the kit draws it. */
  view?: string;
  /** The headless controller behind that screen, when it has one. */
  controller?: string;
  /** What the controller answers for this component. Required with `controller`. */
  answers?: string;
  /** Its id in `model/models.gd` (the shared headless view model). Every component has one. */
  model: string;
  /** A theme type variation (`PKeyUiTheme.VARIATIONS`) the scene's own card wears. */
  variation?: string;
  /** What the scene shows of this component, from the view's own header. Required with `view`. */
  shows?: string;
}

/**
 * Catalog component (packages/brand/kit-copy/components.json) → its Godot pieces. A component the
 * kit does not implement is not here and has no Godot tab. Every catalog component has a view
 * model in `model/models.gd`; a component without a `view` is headless-only in this kit.
 */
export const GODOT_COMPONENTS: Readonly<Record<string, GodotComponent>> = {
  PolarisKeyGate: {
    view: "gate/pkey_gate",
    controller: "gate/gate_controller",
    answers:
      "which screen a license status renders, with its copy keys and its controls",
    model: "PolarisKeyGate",
    shows:
      "The license gate as a full-screen card: it hides and emits `usable` when the license lets the game run, and otherwise shows the activation form, an offline-grace strip, or the screen for the block",
  },
  Boot: {
    view: "boot/pkey_boot",
    model: "Boot",
    shows:
      "The stages from start to ready with a logo, a status line and a progress bar, the gate when the license needs the player, and a card with Try again when the boot stops",
  },
  Welcome: {
    view: "activation/pkey_activation_panel",
    controller: "activation/activation_controller",
    answers:
      "which ways to activate this build offers: key entry, Sign in, Continue free and Activate offline",
    model: "Welcome",
    shows:
      "The ways this build can be activated, and only those: a license key field, Sign in, Continue free and Activate offline",
  },
  SignIn: {
    view: "sign_in/pkey_sign_in_dialog",
    controller: "sign_in/sign_in_controller",
    answers:
      "the copy key for how a sign-in ended, the countdown and the signed-in identity as one line",
    model: "SignIn",
    shows:
      'Device-code sign-in, opened in place by the activation panel\'s Sign in; with `confirm_identity` it stops at the signed-in identity ("Is this you?") until the player accepts on the device',
  },
  SignInHandoff: {
    view: "sign_in/pkey_sign_in_dialog",
    controller: "sign_in/sign_in_controller",
    answers: "the countdown on the code, and the address the player types",
    model: "SignInHandoff",
    shows:
      'The device code in large type, a countdown from its lifetime and Cancel; a phone gets Open browser and Copy link, a desktop or tablet adds a QR code, and a device with no browser gets the address and the QR code with "Use a license key instead"',
  },
  Activate: {
    view: "activation/pkey_activation_panel",
    controller: "activation/activation_controller",
    answers:
      "whether key entry shows (never on a store build unless `allow_key_entry_on_store`), and the plain words for each activation result",
    model: "Activate",
    shows:
      "The key field with Activate, in a form with one primary: a rejected key is an inline error under the field, with the focus on it; a device with no keyboard leads with Sign in instead",
  },
  OfflineActivation: {
    view: "offline/pkey_offline_dialog",
    model: "OfflineActivation",
    shows:
      "Two numbered steps: send the request code (this device's id, with Copy and a QR code where it fits), then load the reply from a file or pasted text; a refused file names the step that failed. On web only paste is offered",
  },
  DeviceLimit: {
    view: "device_limit/pkey_device_limit",
    controller: "device_limit/device_limit_controller",
    answers:
      "the model input from the license's seats, the roster and the manage page, and the device Replace preselects (the least recently used one that is not this one)",
    model: "DeviceLimit",
    shows:
      'A full license as a card of its own: "Your license is on 3 of 3 devices", the roster with the least recently used other device preselected, and Replace and continue. Where devices are managed in the browser it offers Open in browser, or a QR code on a TV',
  },
  Devices: {
    view: "devices/pkey_device_list",
    controller: "devices/devices_controller",
    answers:
      "the roster as the rows the Devices model reads, how long ago each device was last used, and which row is this device",
    model: "Devices",
    shows:
      'The devices using this license as 64 px rows: a form-factor glyph, the name, a "This device" tag, the platform and when it was last used, with Rename and Remove in place (Remove confirms in the row, never in a dialog). A failed load is "Couldn\'t load your devices." with Try again, and browser-only management opens the portal',
  },
  LicenseChoice: {
    view: "license_choice/pkey_license_choice",
    controller: "license_choice/choice_controller",
    answers:
      "the rows the license step offers, which one is selected and what each says about itself (tier, origin and term, seats)",
    model: "LicenseChoice",
    shows:
      'Step 3 of sign-in, when an account holds several licenses: each is a row with its tier, origin, a seat meter and a tag ("On this device", "All devices in use"). One row is selected and Use this license is the one primary; a full license offers Replace a device instead',
  },
  UpdatePrompt: {
    view: "update/pkey_update_prompt",
    controller: "update/update_prompt_controller",
    answers:
      "whether an update answer shows, its copy keys, its action on this build and whether it locks",
    model: "UpdatePrompt",
    variation: "PKeyBanner",
    shows:
      "An update offer as a banner (a strip that never takes the focus from play) or, for a dismissable answer, a modal card; a mandatory or blocked answer is always a locked banner with no dismiss. The action is the outlet's: a store opens its listing, a web export reloads, a direct build installs",
  },
  UpdateProgress: {
    view: "progress/pkey_update_progress",
    controller: "progress/progress_controller",
    answers:
      "the model input for a download or install, the time left from the rate so far, and the sizes as one unit",
    model: "UpdateProgress",
    shows:
      'A compact strip with a counted bar and one line ("Downloading · 38 of 91 MB · 1 minute left") for an app update or content packs. Paused offers Download now and failed offers Try again; it never takes the focus from play and hides while there is no progress',
  },
  ReleaseNotes: {
    view: "release_notes/pkey_release_notes",
    model: "ReleaseNotes",
    shows:
      'What\'s new in the product: the changelog newest first, each entry with its version, date and notes as text. A failed load is "Release notes couldn\'t be loaded." with Try again, and an empty one says "No release notes yet."',
  },
  StatusScreen: {
    view: "gate/pkey_gate",
    controller: "gate/gate_controller",
    answers:
      "which screen a blocking status renders, with its copy keys and its controls",
    model: "StatusScreen",
    shows:
      "Each block on its own screen: revoked (signed out, with sign-in and activation again), expired (connect, and it retries), update required (with the outlet's action when one is known), and not available on this license",
  },
  GraceBanner: {
    view: "banner/pkey_status_banner",
    controller: "banner/banner_controller",
    answers:
      "the lines a license state earns: days of offline grace left, an expired check, when the license was last checked, and an available update",
    model: "GraceBanner",
    variation: "PKeyBanner",
    shows:
      'A thin, non-blocking strip: "Offline — 3 days left", when the license was last checked, and that an update is available. It never takes the focus and hides itself when there is nothing to say',
  },
  Toast: {
    view: "toast/pkey_toast",
    controller: "toast/toast_controller",
    answers:
      "the model view of a toast, which glyph marks its status and its actions (at most two)",
    model: "Toast",
    shows:
      "A brief message over the game: one line, a status glyph, at most two actions and a visible timer that runs out in six seconds. An error stays until dismissed, a toast never steals the focus, and toasts queue behind an error that is still up",
  },
  AccountAndLicense: {
    view: "settings/pkey_account_tab",
    controller: "settings/account_controller",
    answers:
      "what the Account and license pane knows: the tier, who is signed in, the seat count and the update rows",
    model: "AccountAndLicense",
    shows:
      'The pane in inset grouped rows: the license and its status, who is signed in with Manage, Devices with a seat meter, the update rows, and Sign out in a group of its own. It embeds as the first section of `PKeySettingsPanel` or opens as a page; a floating license shows no holder, and offline it says "showing the last saved details"',
  },
  Settings: {
    view: "settings/pkey_settings_panel",
    controller: "settings/settings_controller",
    answers:
      "the rows from the config catalog: their order, widget, lock, provenance badge and whether each shows",
    model: "Settings",
    shows:
      'The product\'s settings from the config catalog\'s UI hints: one list per category, a lock and "Set by <the developer>" on a managed value, "Reset to default" while the player\'s own value is in use',
  },
  Paywall: {
    view: "paywall/pkey_paywall",
    controller: "paywall/paywall_controller",
    answers:
      "the model input from the tier sold and the store or portal, and what the primary button does: purchase, open the portal or finish",
    model: "Paywall",
    shows:
      "An upsell for a tier the player has not unlocked: what it includes, Upgrade to the tier (the platform's store) or Buy in your browser, Redeem a code and Restore purchases where the game wires them. Where nothing is sold it says so",
  },
  EntitlementGate: { model: "EntitlementGate" },
  CloudSyncStatus: {
    view: "cloud_sync/pkey_cloud_sync_status",
    model: "CloudSyncStatus",
    shows:
      'A small status strip: "Synced 2 minutes ago", Syncing, Offline, a conflict with Review, or a failure; signed out it offers Sign in to sync. It hides while Cloud Sync is off and never takes the focus',
  },
  UnlockSync: {
    view: "cloud_sync/pkey_unlock_sync",
    controller: "cloud_sync/cloud_sync_controller",
    answers:
      "the key ring calls the Cloud Sync screens make: unlock with the recovery code, start over with a new key, accept a ring change the person confirmed, and a new recovery code",
    model: "UnlockSync",
    shows:
      "The recovery code field when this device holds no key for the synced data, with Start over and its warning; Try again after a failure, and only Start over when the account holds no code",
  },
  RecoveryCode: {
    view: "cloud_sync/pkey_recovery_code",
    model: "RecoveryCode",
    shows:
      'A new recovery code, shown once as 8 groups of 4, with Copy code and an "I\'ve saved my recovery code" check that Done waits for; the screen keeps nothing after Done',
  },
  RingChange: {
    view: "cloud_sync/pkey_ring_change",
    model: "RingChange",
    shows:
      "Your sync key changed: the device that changed it, Use recovery code first, That was me for the ring the person was shown, and Cancel",
  },
  About: {
    view: "about/pkey_about",
    model: "About",
    shows:
      "The product, its version, Privacy and Get help pages, Open-source licenses and Copy diagnostics, over the game or as a page of its own menu",
  },
  ChannelPicker: {
    view: "dev_menu/pkey_dev_menu_section",
    controller: "dev_menu/dev_menu_controller",
    answers:
      "the channels to offer (the current one, stable, and every channel the license entitles) and the lock reason when the build's outlet owns the channel",
    model: "ChannelPicker",
    shows:
      "A section for the game's own developer menu: a channel picker (locked, with the reason, when the outlet owns the channel), build info, Copy diagnostics and Force check",
  },
};

/**
 * Classes under the kit folder that are a view or a controller and no catalog component's piece,
 * each with the reason. A new view or controller that is neither claimed above nor listed here
 * fails test/godotKit.test.ts.
 */
export const INTERNAL: Readonly<Record<string, string>> = {
  PKeyEntitlementBadge:
    '"Included with" chips a game places beside its own UI; the catalog has no component for them (the framework page lists the scene)',
  PKeySignInStep:
    "The automatic sign-in steps (confirm, link offer, nearby) drawn from the SignIn form's model with an `autoSignIn` input; the catalog has no component of their own, the host's flow drives them",
};

// ── The addon's source ────────────────────────────────────────────────────────────────────

const kitDir = (): string => join(repoRoot(), UI_DIR);

function read(rel: string): string {
  return readFileSync(join(kitDir(), rel), "utf8");
}

/** Every `.gd` file under the kit folder, relative to it, sorted. */
function scripts(dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(kitDir(), dir), {
    withFileTypes: true,
  })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...scripts(rel));
    else if (entry.name.endsWith(".gd")) out.push(rel);
  }
  return out.sort();
}

export interface GodotClass {
  name: string;
  /** The script, relative to the kit folder. */
  file: string;
  /** The first `extends` line's class, or "" when there is none. */
  extends: string;
}

/** The first line of `text` that starts with `keyword name`: a script's class_name and extends. */
function declared(text: string, keyword: "class_name" | "extends"): string {
  return new RegExp(`^${keyword}\\s+(\\w+)`, "m").exec(text)?.[1] ?? "";
}

/** Every `class_name` declared under the kit folder. */
export function godotClasses(): GodotClass[] {
  const out: GodotClass[] = [];
  for (const file of scripts()) {
    const text = read(file);
    const name = declared(text, "class_name");
    if (name !== "")
      out.push({ name, file, extends: declared(text, "extends") });
  }
  return out;
}

/** The `class_name` of the script at `stem` (relative to the kit folder, no extension). */
export function classOf(stem: string): string {
  const name = declared(read(`${stem}.gd`), "class_name");
  if (name === "")
    throw new Error(`godotKit: ${stem}.gd declares no class_name`);
  return name;
}

/** A scene's path in the kit folder, as the framework page writes it: `gate/pkey_gate.tscn`. */
export function scenePath(stem: string): string {
  return `${stem}.tscn`;
}

/** The component ids of `model/models.gd`'s MODELS table. */
export function modelIds(): string[] {
  const text = read("model/models.gd");
  const block = /^const MODELS := \{\n([\s\S]*?)^\}/m.exec(text)?.[1];
  if (block === undefined)
    throw new Error("godotKit: no MODELS table in models.gd");
  return [...block.matchAll(/^\t"(\w+)":/gm)].map((m) => m[1]!);
}

/** The theme type variations of `theme/pkey_ui_theme.gd`'s VARIATIONS table. */
export function themeVariations(): string[] {
  const text = read("theme/pkey_ui_theme.gd");
  const block = /^const VARIATIONS := \{\n([\s\S]*?)^\}/m.exec(text)?.[1];
  if (block === undefined) {
    throw new Error("godotKit: no VARIATIONS table in pkey_ui_theme.gd");
  }
  return [...block.matchAll(/^\t"(\w+)":/gm)].map((m) => m[1]!);
}

/** A view (`extends PKeyUiView`) or a controller (`*_controller.gd`): a class the docs must place. */
export function isViewOrController(c: GodotClass): boolean {
  return c.extends === "PKeyUiView" || c.file.endsWith("_controller.gd");
}

/** The classes the registry names, over every component: views, controllers. */
export function claimedClasses(): string[] {
  const out = new Set<string>();
  for (const c of Object.values(GODOT_COMPONENTS)) {
    if (c.view !== undefined) out.add(classOf(c.view));
    if (c.controller !== undefined) out.add(classOf(c.controller));
  }
  return [...out].sort();
}

// ── What a tab says ───────────────────────────────────────────────────────────────────────

/** A run of a paragraph: text, `code`, or a link. */
export type Seg = string | { code: string } | { href: string; text: string };

export interface GodotParagraph {
  /** "Drop-in", "Styled part" or "Headless". */
  label: string;
  segs: Seg[];
}

export const FRAMEWORK_HREF = "/docs/build/ui/frameworks/godot/";
export const OWN_UI_HREF = "/docs/build/sdks/godot/your-own-ui/";

/** Text with `backticked` runs as code segments. */
function inline(text: string): Seg[] {
  return text
    .split("`")
    .map((part, i): Seg => (i % 2 === 1 ? { code: part } : part))
    .filter((s) => s !== "");
}

/** The tab's paragraphs for a catalog component, read from the registry and the addon. */
export function godotTab(component: string): GodotParagraph[] {
  const c = GODOT_COMPONENTS[component];
  if (c === undefined) {
    throw new Error(`godotKit: ${component} is not a Godot kit component`);
  }
  const out: GodotParagraph[] = [];

  if (c.view === undefined) {
    out.push({
      label: "Drop-in",
      segs: [
        "The Godot kit has no scene for this component; draw it from the headless view model below.",
      ],
    });
  } else {
    out.push({
      label: "Drop-in",
      segs: [
        { code: classOf(c.view) },
        " (",
        { code: scenePath(c.view) },
        "). ",
        ...inline(`${c.shows}.`),
      ],
    });
    const styled: Seg[] = [
      "The scene on its own: instance ",
      { code: scenePath(c.view) },
      " and add it as a child; it finds the ",
      { code: "PolarisKey" },
      " autoload by itself.",
    ];
    if (c.variation !== undefined) {
      styled.push(
        " Its card wears the ",
        { code: c.variation },
        " theme type variation.",
      );
    }
    out.push({ label: "Styled part", segs: styled });
  }

  const headless: Seg[] = [];
  if (c.controller !== undefined) {
    headless.push(
      { code: classOf(c.controller) },
      ...inline(` answers ${c.answers ?? ""}. `),
    );
  }
  headless.push(
    { code: `view_of("${c.model}", input)` },
    " in ",
    { code: "model/models.gd" },
    " returns the shared view model: its state, copy keys and actions.",
  );
  out.push({ label: "Headless", segs: headless });

  out.push({
    label: "",
    segs: [
      { href: FRAMEWORK_HREF, text: "Godot" },
      " has every scene, the options and the theme; ",
      { href: OWN_UI_HREF, text: "Your own UI" },
      " draws each screen yourself.",
    ],
  });
  return out;
}

/** A paragraph as plain text, for tests and a quick look. */
export function plain(p: GodotParagraph): string {
  const body = p.segs
    .map((s) =>
      typeof s === "string" ? s : "code" in s ? `\`${s.code}\`` : s.text,
    )
    .join("");
  return p.label === "" ? body : `${p.label}. ${body}`;
}
