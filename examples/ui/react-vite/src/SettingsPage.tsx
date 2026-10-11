// The kit's parts placed by the app (UI-KITS.md §1.3, layer b): this page reads the SDK through
// its hooks and hands each part what it shows. The parts draw in the product's look with no
// theme code: the provider's presentation (Tidewater's accent and name) reaches them by itself.
import { useEffect, useState } from "react";
import { usePolarisKey, type DeviceInfo } from "@polaris-key/react";
import {
  About,
  Devices,
  Settings,
  UpdatePrompt,
  type UiInput,
} from "@polaris-key/react/kit";

const FORM_FACTOR: Record<string, string> = {
  macos: "mac",
  ipados: "ipad",
  ios: "phone",
  android: "phone",
};

function deviceRows(list: DeviceInfo[]): NonNullable<UiInput["devices"]> {
  const now = Date.now() / 1000;
  return list.map((d) => ({
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

export function SettingsPage() {
  const pk = usePolarisKey();
  const [devices, setDevices] = useState<UiInput["devices"]>();
  const [devicesFailed, setDevicesFailed] = useState(false);
  const [update, setUpdate] = useState<UiInput["update"]>();

  useEffect(() => {
    let live = true;
    pk.listDevices()
      .then((list) => live && setDevices(deviceRows(list)))
      .catch(() => live && setDevicesFailed(true));
    pk.checkUpdate()
      .then(
        (v) =>
          live &&
          setUpdate(
            v.updateAvailable
              ? { action: "binary", version: v.version }
              : { action: "none" },
          ),
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Once per visit to the page.
  }, []);

  const config: UiInput["config"] = pk.listUserConfig().map((e) => ({
    key: e.key,
    type: typeof e.value === "number" ? "number" : typeof e.value,
    source: e.enforced ? "enforced" : "default",
    locked: e.enforced,
    // A locked row names who set it: here, the product's operator.
    ...(e.enforced ? { org: "Harbor Audio" } : {}),
    value: e.value,
  }));

  return (
    <div className="settings">
      <h1>Settings</h1>
      {update && <UpdatePrompt input={{ update }} />}
      <Devices
        input={
          devicesFailed
            ? { error: { code: "network" } }
            : devices
              ? { devices }
              : { loading: true }
        }
      />
      <Settings input={{ config }} />
      <About input={{}} />
    </div>
  );
}
