"use client";
// Layer (a) for the parts that act: inside `<PolarisKeyProvider>`, `<Devices>`, `<Settings>`,
// `<UpdatePrompt>` and `<About>` given no `input` read the SDK themselves (UI-KITS.md §1.3, DL18)
// and run their own local states: renaming, confirming a removal, saving a setting, the error with
// Try again, the update check, the copied diagnostics. Given an `input`, each is the plain part
// (layer b) and the host drives it. The models decide every state; nothing here draws.

import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WEB_ADD_IN, type AddIn, type UiInput } from "@polaris-key/ui-core";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { ProductCatalog } from "@polaris-key/catalog";

import type { DeviceInfo, PolarisAdapter } from "../core/index.js";
import { PolarisContext } from "../react/context.js";
import { useAdapterState } from "../react/hooks.js";
import type { KitAction, KitProps } from "./component.js";
import { kitComponent } from "./kitComponent.js";
import { openLink, safeLink } from "./links.js";
import { openManage } from "@polaris-key/ui-core/browser";
import { installProgressInput } from "./adapt.js";
import type { SettingsRow } from "./views.js";
import { holderScreen } from "./holdersLazy.js";
import type { AddToAccountProps } from "./holders.js";
import type { AddFlow, SessionSlot } from "./holderGate.js";

type Props = KitProps;

const Devices_ = kitComponent("Devices");
const Settings_ = kitComponent("Settings");
const UpdatePrompt_ = kitComponent("UpdatePrompt");
const About_ = kitComponent("About");
const AccountAndLicense_ = kitComponent("AccountAndLicense");
const AddToAccount_ = holderScreen<AddToAccountProps>("AddToAccount");

/** The adapter and what the provider knows, or `null` outside `<PolarisKeyProvider>`. */
function useSdk() {
  return useContext(PolarisContext);
}

const FORM_FACTOR: Record<string, string> = {
  macos: "mac",
  ipados: "ipad",
  ios: "phone",
  android: "phone",
};

function deviceInputs(list: readonly DeviceInfo[]): UiInput["devices"] {
  const now = Date.now() / 1000;
  return list.map((d) => ({
    id: d.id,
    name: d.label ?? null,
    platform: d.platform ?? null,
    formFactor: (d.platform && FORM_FACTOR[d.platform]) ?? "computer",
    lastSeenDays:
      d.lastVerifiedAt !== undefined
        ? Math.max(0, Math.floor((now - d.lastVerifiedAt) / 86_400))
        : null,
    current: d.current,
  }));
}

/** Chain a host's own handler after the part's. */
const both =
  <A extends unknown[]>(first: (...a: A) => void, then?: (...a: A) => void) =>
  (...a: A): void => {
    first(...a);
    then?.(...a);
  };

// ── Devices ──────────────────────────────────────────────────────────────────────────────────

type DeviceEdit = { kind: "rename" | "remove"; index: number };

function DrivenDevices(props: Props & { adapter: PolarisAdapter }): ReactNode {
  const { adapter, ...rest } = props;
  const [list, setList] = useState<DeviceInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [edit, setEdit] = useState<DeviceEdit | null>(null);
  const [editFailed, setEditFailed] = useState(false);
  const typed = useRef("");

  const load = useCallback(() => {
    setLoadFailed(false);
    adapter
      .listDevices()
      .then((l) => setList(l))
      .catch(() => setLoadFailed(true));
  }, [adapter]);
  useEffect(load, [load]);

  const run = useCallback(
    (e: DeviceEdit, op: "rename" | "remove") => {
      const d = list?.[e.index];
      if (!d) return;
      setEditFailed(false);
      const done = (): void => {
        setEdit(null);
        load();
      };
      const failed = (): void => setEditFailed(true);
      if (op === "rename")
        adapter
          .renameDevice(d.id, typed.current.trim() || null)
          .then(done, failed);
      else adapter.deauthorizeDevice(d.id).then(done, failed);
    },
    [adapter, list, load],
  );

  const onAction = (a: KitAction): void => {
    const index = typeof a.index === "number" ? a.index : -1;
    switch (a.key) {
      case "devices.rename":
        typed.current = list?.[index]?.label ?? "";
        setEditFailed(false);
        setEdit({ kind: "rename", index });
        return;
      case "devices.remove":
        // In the list it asks; in the confirmation it removes.
        if (a.state === "confirming" && edit) run(edit, "remove");
        else {
          setEditFailed(false);
          setEdit({ kind: "remove", index });
        }
        return;
      case "common.save":
        if (edit?.kind === "rename") run(edit, "rename");
        return;
      case "common.cancel":
        setEdit(null);
        setEditFailed(false);
        return;
      case "common.tryAgain":
        if (edit && editFailed) run(edit, edit.kind);
        else load();
        return;
    }
  };

  const input: UiInput = useMemo(() => {
    const row = edit ? list?.[edit.index] : undefined;
    return {
      ...(list ? { devices: deviceInputs(list) } : {}),
      ...(list === null && !loadFailed ? { loading: true } : {}),
      ...(loadFailed || editFailed ? { error: { code: "network" } } : {}),
      ...(edit
        ? {
            edit: {
              kind: edit.kind,
              device: row?.label ?? "",
            },
            selected: String(edit.index),
          }
        : {}),
    };
  }, [list, loadFailed, edit, editFailed]);

  return (
    <Devices_
      {...rest}
      driven
      input={input}
      onAction={both(onAction, props.onAction)}
      onInput={both((f: string, v: string) => {
        if (f === "rename") typed.current = v;
      }, props.onInput)}
    />
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

function formatNumber(n: number, locale: string | undefined): string {
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}

function numberOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The rows the part draws: the SDK's settings, labelled and typed by the product's catalog. */
function settingRows(
  adapter: PolarisAdapter,
  catalog: ProductCatalog | null,
  org: string | undefined,
  locale: string | undefined,
): SettingsRow[] {
  const byKey = new Map((catalog?.entries ?? []).map((e) => [e.key, e]));
  const rows: SettingsRow[] = [];
  for (const e of adapter.listUserConfig()) {
    const entry = byKey.get(e.key);
    if (entry?.user?.listed === false) continue;
    const schema = (entry?.schema ?? {}) as Record<string, unknown>;
    const enumValues = Array.isArray(schema.enum)
      ? (schema.enum as unknown[]).map(String)
      : undefined;
    const labels = entry?.ui?.optionLabels ?? {};
    const unit = entry?.ui?.unit;
    const readable = (v: string): string => {
      if (labels[v] !== undefined) return labels[v];
      const n = Number(v);
      if (typeof e.value !== "number" || !Number.isFinite(n)) return v;
      return unit
        ? `${formatNumber(n, locale)} ${unit}`
        : formatNumber(n, locale);
    };
    const options = enumValues?.map((v) => ({ value: v, label: readable(v) }));
    const min = numberOf(schema.minimum);
    const max = numberOf(schema.maximum);
    const typeName = typeof e.value === "number" ? "number" : typeof e.value;
    let display: string | undefined;
    if (typeof e.value === "number") {
      display = formatNumber(e.value, locale);
      if (unit) display += ` ${unit}`;
    } else if (typeof e.value === "string")
      display = labels[e.value] ?? e.value;
    rows.push({
      key: e.key,
      type: typeName,
      source: adapter.getConfigSource(e.key) === "local" ? "local" : "default",
      locked: e.enforced,
      ...(e.enforced && org ? { org } : {}),
      value: e.value,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(entry?.ui?.advanced ? { advanced: true } : {}),
      ...(entry?.label ? { label: entry.label } : {}),
      ...(display !== undefined ? { display } : {}),
      ...(options ? { options } : {}),
      ...(schema.type === "integer" ? { step: 1 } : {}),
    });
  }
  return rows;
}

/** The typed value a field reported, as the setting's own type; `undefined` when it is not one. */
function parseSetting(row: SettingsRow, raw: string): JSONValue | undefined {
  if (typeof row.value === "boolean") return raw === "true";
  if (row.type === "number") {
    if (raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (row.min !== undefined && n < row.min) return undefined;
    if (row.max !== undefined && n > row.max) return undefined;
    return n;
  }
  return raw;
}

/** AddToAccount from the account pane's "Not in an account" row (UK-42): in place of the pane, over
 *  the SDK; Cancel and Start using go back to it. Leaving it cancels the model and its sign-in. */
function AddInAccount(props: {
  adapter: PolarisAdapter;
  services: string[];
  theme?: KitProps["theme"];
  onClose: () => void;
}): ReactNode {
  const { adapter } = props;
  const slot = useRef<SessionSlot>({ current: null });
  const flow = useRef<AddFlow | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let live = true;
    void import("./holderGate.js").then((m) => {
      if (!live) return;
      flow.current = m.createAddFlow(adapter, slot.current, "device", redraw);
      redraw();
    });
    return () => {
      live = false;
      flow.current?.drop();
      flow.current = null;
    };
  }, [adapter]);
  const f = flow.current;
  if (!f) return null;
  const m = f.model;
  const input: UiInput = {
    ...m.input(),
    services: props.services as NonNullable<UiInput["services"]>,
  };
  return (
    <AddToAccount_
      bare
      {...(props.theme ? { theme: props.theme } : {})}
      input={input}
      onAction={(a: KitAction) => {
        switch (a.key) {
          case "common.continue":
            if (typeof a.name === "string") m.setField("name", a.name);
            if (typeof a.email === "string") m.setField("email", a.email);
            void m.submit();
            return;
          case "common.tryAgain":
            void m.tryAgain();
            return;
          case "common.cancel":
          case "signin.done.start":
            props.onClose();
            return;
          case "signin.key.ownedSignIn":
            void adapter.signInWithOidc().catch(() => undefined);
            return;
          case "activate.otherEmail.verify":
          case "signin.auto.confirm.other":
            void m.cancel();
            return;
        }
      }}
    />
  );
}

/** The account pane a host-opened Settings carries (the menu's "Manage License…"): the license,
 *  its devices, the version, the update controls and Sign Out, from what the SDK knows. */
function OpenedAccount(props: {
  adapter: PolarisAdapter;
  version?: string;
  theme?: KitProps["theme"];
  onCheckUpdates?: () => void;
  onSignedOut: () => void;
  addIn?: AddIn;
}): ReactNode {
  const { adapter } = props;
  const addIn = props.addIn ?? WEB_ADD_IN;
  const sdk = useSdk();
  const state = useAdapterState(adapter);
  const [used, setUsed] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const licenseOn = state.capabilities.license.enabled;
  useEffect(() => {
    if (!licenseOn) return;
    let live = true;
    adapter
      .listDevices()
      .then((l) => live && setUsed(l.length))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [adapter, licenseOn]);
  const caps = state.capabilities;
  const name = state.profile?.name ?? state.profile?.email;
  const tier = state.entitlements.tier;
  // "Manage" opens the page a refusal handed over (the device-limit `manageUrl`); the SDK has
  // no other account page, so without one the button is left out.
  const manageUrl = safeLink(state.error?.license?.manageUrl);
  const services = (Object.keys(caps) as (keyof typeof caps)[]).filter(
    (s) => caps[s].enabled,
  );
  // The license's holder, from the signed document's profile (UK-42): no email is floating, and
  // an account signed in on this device is never called floating.
  const profile = state.profile;
  const holder =
    profile && !profile.user
      ? { email: typeof profile.email === "string" ? profile.email : "" }
      : undefined;
  if (adding)
    return (
      <AddInAccount
        adapter={adapter}
        services={services}
        {...(props.theme ? { theme: props.theme } : {})}
        onClose={() => setAdding(false)}
      />
    );
  const input: UiInput = {
    services,
    ...(holder ? { licenseHolder: holder } : {}),
    gate: { status: state.status },
    account: {
      // A floating license has no name or email: nobody is signed in (UK-42).
      signedIn: caps.identity.enabled && !!name?.trim(),
      ...(name !== undefined ? { holder: name } : {}),
      ...(typeof tier === "string" ? { tier } : {}),
      canManage: manageUrl !== null,
      ...(used !== null ? { devices: { used, limit: null } } : {}),
    },
    ...(props.version ? { bundle: { slug: "", version: props.version } } : {}),
  };
  return (
    <AccountAndLicense_
      bare
      headingLevel={3}
      driven
      {...(props.theme ? { theme: props.theme } : {})}
      input={input}
      onAction={(a: KitAction) => {
        if (a.key === "common.signOut")
          void adapter.signOut().then(props.onSignedOut, props.onSignedOut);
        else if (a.key === "update.checkNow") props.onCheckUpdates?.();
        else if (a.key === "common.manage" && manageUrl) openLink(manageUrl);
        else if (a.key === "activate.recommend.action") {
          // Add your name and email: the product's page (WEB_ADD_IN), or AddToAccount here when
          // switched to "app" (no key is held in this pane, so none is sent).
          if (addIn === "app" && caps.identity.enabled) setAdding(true);
          else
            void import("./holderGate.js")
              .then((m) =>
                m.portalTarget(adapter, {
                  ...(sdk?.baseUrl !== undefined
                    ? { baseUrl: sdk.baseUrl }
                    : {}),
                  ...(sdk?.productSlug !== undefined
                    ? { product: sdk.productSlug }
                    : {}),
                }),
              )
              .then((t) => {
                if (t) openManage(t.url);
              })
              .catch(() => undefined);
        }
      }}
    />
  );
}

export function DrivenSettings(
  props: Props & {
    adapter: PolarisAdapter;
    version?: string;
    onCheckUpdates?: () => void;
    /** Where Add your name and email goes; defaults to the web switch (`WEB_ADD_IN`). */
    addIn?: AddIn;
  },
): ReactNode {
  const { adapter, version, onCheckUpdates, addIn, ...rest } = props;
  // Re-read whenever the SDK's state moves (a local write lands there).
  const state = useAdapterState(adapter);
  const [catalog, setCatalog] = useState<ProductCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  // The catalog is asked for once the SDK knows the product runs Config (not at first paint).
  const configOn = state.capabilities.config.enabled;
  useEffect(() => {
    if (!configOn) return;
    let live = true;
    void adapter.fetchSchema().then((c) => live && setCatalog(c));
    return () => {
      live = false;
    };
  }, [adapter, configOn]);
  const org = useMemo(() => {
    try {
      return adapter.presentationSource().current()?.developerName ?? undefined;
    } catch {
      return undefined;
    }
  }, [adapter]);
  const rows = useMemo(
    () => settingRows(adapter, catalog, org, props.theme?.locale),
    // The SDK's state moves when a setting changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter, catalog, org, state.config, state.localOverrides],
  );
  const last = useRef<{ row: SettingsRow; raw: string } | null>(null);

  const save = useCallback(
    (row: SettingsRow, raw: string) => {
      const value = parseSetting(row, raw);
      // A value the field cannot hold is not sent: the field shows the setting's own value.
      if (value === undefined) return;
      last.current = { row, raw };
      setFailed(false);
      adapter.config.set(row.key, value).then(
        () => setFailed(false),
        () => setFailed(true),
      );
    },
    [adapter],
  );

  const input: UiInput = {
    config: rows,
    ...(failed ? { error: { code: "settings" }, edit: { kind: "value" } } : {}),
  };
  return (
    <Settings_
      {...rest}
      driven
      {...(props.onDismiss
        ? {
            account: (
              <OpenedAccount
                adapter={adapter}
                {...(version !== undefined ? { version } : {})}
                {...(props.theme ? { theme: props.theme } : {})}
                {...(onCheckUpdates ? { onCheckUpdates } : {})}
                {...(addIn ? { addIn } : {})}
                onSignedOut={props.onDismiss}
              />
            ),
          }
        : {})}
      input={input}
      onAction={both((a: KitAction) => {
        if (a.key === "common.tryAgain" && last.current)
          save(last.current.row, last.current.raw);
        // Reset to default: drop every override of this device's.
        if (a.key === "settings.reset")
          adapter.config.clearAll().then(
            () => setFailed(false),
            () => setFailed(true),
          );
      }, props.onAction)}
      onInput={both((field: string, value: string) => {
        if (!field.startsWith("config:")) return;
        const row = rows.find((r) => r.key === field.slice(7));
        if (row) save(row, value);
      }, props.onInput)}
    />
  );
}

// ── UpdatePrompt ─────────────────────────────────────────────────────────────────────────────

/** A host-opened update (a native menu item): the prompt is a modal dialog, an up-to-date answer
 *  is shown rather than left out, and `onClose` runs when the person closes it. */
interface Opened {
  onClose: () => void;
}

type Found = {
  version: string;
  url: string;
  notes?: NonNullable<UiInput["releaseNotes"]>;
  more?: string;
};

export function DrivenUpdate(
  props: Props & {
    adapter: PolarisAdapter;
    version?: string;
    opened?: Opened;
  },
): ReactNode {
  const { adapter, version, opened, ...rest } = props;
  // `undefined`: not answered yet; `null`: nothing newer.
  const [found, setFound] = useState<Found | null | undefined>(undefined);
  const [skipped, setSkipped] = useState(false);
  // The install in flight (desktop): real bytes, then a restart to offer.
  const [install, setInstall] = useState<
    | { kind: "running"; progress?: ReturnType<typeof installProgressInput> }
    | { kind: "ready"; restart: () => Promise<void> }
    | null
  >(null);
  const [recheck, setRecheck] = useState(0);
  // Asked once the SDK knows the product publishes updates (not at first paint).
  const state = useAdapterState(adapter);
  const updatesOn = state.capabilities.update.enabled;
  const desktop = state.mode === "desktop";
  const close = opened?.onClose;
  useEffect(() => {
    if (!updatesOn) {
      if (close) close();
      return;
    }
    let live = true;
    adapter
      .checkUpdate()
      .then(async (v) => {
        if (!live) return;
        if (!v.updateAvailable) {
          setFound(null);
          return;
        }
        setFound(v);
        // The changelog entry supplies "What's new" and the release page; without one, neither.
        const e = (await adapter.changelog().catch(() => [])).find(
          (c) => c.version === v.version,
        );
        const notes = (e?.summary ?? "")
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 3)
          .join("\n");
        if (live && e)
          setFound({
            ...v,
            ...(notes
              ? { notes: [{ version: v.version, date: e.date ?? "", notes }] }
              : {}),
            ...(safeLink(e.url) ? { more: e.url } : {}),
          });
      })
      .catch(() => {
        // The adapter holds the error (`error.update`); a host-opened dialog has nothing to show.
        if (live && close) close();
      });
    return () => {
      live = false;
    };
  }, [adapter, updatesOn, recheck]);
  const done = (): void => {
    setSkipped(true);
    close?.();
  };
  // Install through the host's driver and draw its real bytes; anything it cannot install (or
  // refuses) falls back to the download page, as before.
  const installNow = async (url: string): Promise<void> => {
    const fallback = (): void => {
      const safe = safeLink(url);
      if (safe) openLink(safe);
    };
    if (!desktop) return fallback();
    setInstall({ kind: "running" });
    try {
      const { decision } = await adapter.decideUpdate();
      const out = await adapter.installUpdate(decision, {
        onProgress: (d, t) =>
          setInstall({
            kind: "running",
            progress: installProgressInput(
              d,
              t,
              typeof navigator !== "undefined" ? navigator.language : undefined,
            ),
          }),
      });
      if (out.kind === "restartRequired")
        setInstall({ kind: "ready", restart: out.restart });
      else if (out.kind === "unsupported") {
        setInstall(null);
        fallback();
      } else {
        // Handed off or opened a store: the installer or the store owns it now.
        setInstall(null);
        done();
      }
    } catch {
      setInstall(null);
      fallback();
    }
  };
  // Nothing newer, or put off: an inline part draws nothing (it never says "up to date"
  // unasked); a host-opened dialog says so.
  if (found === undefined || skipped) return null;
  if (found === null && !opened) return null;
  const input: UiInput = {
    update:
      found === null
        ? { action: "none" }
        : install?.kind === "ready"
          ? { action: "code-ready", version: found.version }
          : install?.kind === "running"
            ? {
                action: "binary",
                version: found.version,
                progress: install.progress ?? { phase: "download" },
              }
            : { action: "binary", version: found.version },
    ...(version ? { bundle: { slug: "", version } } : {}),
    ...(found?.notes ? { releaseNotes: found.notes } : {}),
  };
  return (
    <UpdatePrompt_
      {...(opened ? { onDismiss: opened.onClose } : { embedded: true })}
      driven
      {...rest}
      input={input}
      onAction={both((a: KitAction) => {
        if (a.key === "update.checkNow") {
          setRecheck((n) => n + 1);
        } else if (found && a.key === "update.restartNow") {
          if (install?.kind === "ready") void install.restart().catch(() => {});
        } else if (
          found &&
          (a.key === "update.install" || a.key === "update.restartWhenReady")
        ) {
          // One install at a time: a press while it runs does nothing.
          if (install?.kind !== "running") void installNow(found.url);
        } else if (found && a.key === "update.allChanges") {
          const url = safeLink(found.more ?? found.url);
          if (url) openLink(url);
        } else if (a.key === "update.later" || a.key === "update.skipVersion")
          done();
      }, props.onAction)}
    />
  );
}

// ── About ────────────────────────────────────────────────────────────────────────────────────

function DrivenAbout(
  props: Props & {
    adapter: PolarisAdapter;
    version?: string;
    productSlug?: string;
  },
): ReactNode {
  const { adapter, version, productSlug, ...rest } = props;
  const state = useAdapterState(adapter);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(id);
  }, [copied]);
  const input: UiInput = {
    ...(version ? { bundle: { slug: productSlug ?? "", version } } : {}),
    ...(copied ? { saved: true } : {}),
  };
  return (
    <About_
      {...rest}
      driven
      input={input}
      // Handling input is what keeps a part's context through its states.
      onInput={props.onInput ?? (() => undefined)}
      onAction={both((a: KitAction) => {
        if (a.key !== "about.copyDiagnostics") return;
        // What a support request needs, and nothing secret: no key, no token, no document.
        const report = {
          product: productSlug,
          app: version,
          sdk: "@polaris-key/react",
          mode: state.mode,
          license: state.status,
          services: Object.entries(state.capabilities)
            .filter(([, v]) => v.enabled)
            .map(([k]) => k),
        };
        void navigator.clipboard
          ?.writeText(JSON.stringify(report, null, 2))
          .then(() => setCopied(true))
          .catch(() => undefined);
      }, props.onAction)}
    />
  );
}

// ── The parts ────────────────────────────────────────────────────────────────────────────────

/** The license's devices; inside the provider and given no `input`, renames and removes them. */
export function Devices(props: Props): ReactNode {
  const sdk = useSdk();
  if (props.input !== undefined || !sdk) return <Devices_ {...props} />;
  return <DrivenDevices {...props} adapter={sdk.adapter} />;
}

/** The person's settings; inside the provider and given no `input`, edits them. */
export function Settings(props: Props): ReactNode {
  const sdk = useSdk();
  if (props.input !== undefined || !sdk) return <Settings_ {...props} />;
  return <DrivenSettings {...props} adapter={sdk.adapter} />;
}

/** The update prompt; inside the provider and given no `input`, checks and offers the update. */
export function UpdatePrompt(props: Props): ReactNode {
  const sdk = useSdk();
  if (props.input !== undefined || !sdk) return <UpdatePrompt_ {...props} />;
  return (
    <DrivenUpdate
      {...props}
      adapter={sdk.adapter}
      {...(sdk.version !== undefined ? { version: sdk.version } : {})}
    />
  );
}

/** The about pane; inside the provider and given no `input`, names the app and copies diagnostics. */
export function About(props: Props): ReactNode {
  const sdk = useSdk();
  if (props.input !== undefined || !sdk) return <About_ {...props} />;
  return (
    <DrivenAbout
      {...props}
      adapter={sdk.adapter}
      {...(sdk.version !== undefined ? { version: sdk.version } : {})}
      {...(sdk.productSlug !== undefined
        ? { productSlug: sdk.productSlug }
        : {})}
    />
  );
}
