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
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { UiInput } from "@polaris-key/ui-core";
import type { JSONValue } from "@polaris-key/protocol/core";
import type { ProductCatalog } from "@polaris-key/catalog";

import type { DeviceInfo, PolarisAdapter } from "../core/index.js";
import { PolarisContext } from "../react/context.js";
import { useAdapterState } from "../react/hooks.js";
import { kitComponent, type KitAction, type KitProps } from "./component.js";
import { openLink, safeLink } from "./links.js";
import type { SettingsRow } from "./views.js";

type Props = KitProps;

const Devices_ = kitComponent("Devices");
const Settings_ = kitComponent("Settings");
const UpdatePrompt_ = kitComponent("UpdatePrompt");
const About_ = kitComponent("About");

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

function DrivenSettings(props: Props & { adapter: PolarisAdapter }): ReactNode {
  const { adapter, ...rest } = props;
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

function DrivenUpdate(
  props: Props & { adapter: PolarisAdapter; version?: string },
): ReactNode {
  const { adapter, version, ...rest } = props;
  const [found, setFound] = useState<{
    version: string;
    url: string;
    notes?: NonNullable<UiInput["releaseNotes"]>;
    more?: string;
  } | null>(null);
  const [skipped, setSkipped] = useState(false);
  // Asked once the SDK knows the product publishes updates (not at first paint).
  const updatesOn = useAdapterState(adapter).capabilities.update.enabled;
  useEffect(() => {
    if (!updatesOn) return;
    let live = true;
    adapter
      .checkUpdate()
      .then(async (v) => {
        if (!live || !v.updateAvailable) return;
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
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [adapter, updatesOn]);
  // Nothing newer, or put off: the part draws nothing (it never says "up to date" unasked).
  if (!found || skipped) return null;
  const input: UiInput = {
    update: { action: "binary", version: found.version },
    ...(version ? { bundle: { slug: "", version } } : {}),
    ...(found.notes ? { releaseNotes: found.notes } : {}),
  };
  return (
    <UpdatePrompt_
      embedded
      driven
      {...rest}
      input={input}
      onAction={both((a: KitAction) => {
        if (a.key === "update.install" || a.key === "update.restartWhenReady") {
          const url = safeLink(found.url);
          if (url) openLink(url);
        } else if (a.key === "update.allChanges") {
          const url = safeLink(found.more ?? found.url);
          if (url) openLink(url);
        } else if (a.key === "update.later" || a.key === "update.skipVersion")
          setSkipped(true);
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
