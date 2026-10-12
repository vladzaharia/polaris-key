"use client";

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

/** The App Router settings content, assembled from the React kit parts. */
export function SettingsContent() {
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
    ...(e.enforced ? { org: "Harbor Audio" } : {}),
    value: e.value,
  }));

  return (
    <div className="settings">
      <h1>Settings</h1>
      {update && <UpdatePrompt input={{ update }} />}
      <section className="settings-part" aria-labelledby="devices-heading">
        <h2 id="devices-heading">Devices</h2>
        <Devices
          input={
            devicesFailed
              ? { error: { code: "network" } }
              : devices
                ? { devices }
                : { loading: true }
          }
        />
      </section>
      <section
        className="settings-part"
        aria-labelledby="managed-settings-heading"
      >
        <h2 id="managed-settings-heading">Managed settings</h2>
        <Settings input={{ config }} />
      </section>
      <section className="about" aria-labelledby="about-heading">
        <h2 id="about-heading">About</h2>
        <About input={{}} />
      </section>
    </div>
  );
}
