// The index of states: the gate's screens as links, and the panes and dialogs running on
// fixtures (rename and remove a device, change a setting, an optional update, the sign-in sheet).
import {
  PolarisKey,
  type PkElement,
  type PkSignIn,
} from "@polaris-key/elements";

import { STATES, TIDEWATER, fakeSignIn } from "./fixtures";

PolarisKey.theme({
  product: {
    name: "Tidewater Studio",
    developer: "Harbor Audio",
    accent: "#369186",
  },
});

const list = document.getElementById("gate-states")!;
for (const s of STATES) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  a.href = `./index.html?state=${s}`;
  a.textContent = s;
  li.append(a);
  list.append(li);
}

const devices = document.getElementById("devices") as PkElement;
devices.input = {
  ...TIDEWATER,
  devices: [
    {
      id: "dev_laptop",
      name: "Work laptop",
      platform: "windows",
      formFactor: "computer",
      lastSeenDays: 12,
      current: false,
    },
    {
      id: "dev_ipad",
      name: "Mara's iPad",
      platform: "ios",
      formFactor: "tablet",
      lastSeenDays: 3,
      current: false,
    },
    {
      id: "dev_mac",
      name: "MacBook Pro",
      platform: "macos",
      formFactor: "computer",
      lastSeenDays: 0,
      current: true,
    },
  ],
};
// Rename and Remove end in the host: it updates the list and the pane follows.
devices.addEventListener("pk-action", (e) => {
  const d = (e as CustomEvent).detail as {
    key: string;
    deviceId?: string;
    name?: string;
  };
  const list = devices.input.devices ?? [];
  if (d.key === "devices.remove")
    devices.input = {
      ...devices.input,
      devices: list.filter((x) => x.id !== d.deviceId),
    };
  if (d.key === "common.save")
    devices.input = {
      ...devices.input,
      devices: list.map((x) =>
        x.id === d.deviceId ? { ...x, name: d.name ?? x.name } : x,
      ),
    };
});

const settings = document.getElementById("settings") as PkElement;
settings.input = {
  ...TIDEWATER,
  config: [
    {
      key: "audio.volume",
      value: 80,
      source: "local",
      locked: false,
      type: "number",
      min: 0,
      max: 100,
    },
    {
      key: "ui.sounds",
      value: false,
      source: "env",
      locked: false,
      type: "boolean",
    },
    {
      key: "ui.compact",
      value: true,
      source: "default",
      locked: false,
      type: "boolean",
    },
  ],
};

const update = document.getElementById("update") as PkElement;
document.getElementById("open-update")!.addEventListener("click", () => {
  update.input = {
    ...TIDEWATER,
    update: { action: "binary", version: "2.5.0" },
  };
});
update.addEventListener("pk-action", (e) => {
  const { key } = (e as CustomEvent).detail as { key: string };
  if (key === "update.later") update.input = { ...TIDEWATER };
  if (key === "update.install")
    update.input = {
      ...TIDEWATER,
      update: {
        action: "binary",
        version: "2.5.0",
        progress: { phase: "download", fraction: 0.4 },
      },
    };
});

document.getElementById("open-sign-in")!.addEventListener("click", () => {
  const form = document.createElement("pk-sign-in") as PkSignIn;
  form.presentation = "sheet";
  form.primitives = fakeSignIn();
  form.input = { ...TIDEWATER };
  document.body.append(form);
  form.show();
  form.addEventListener("pk-close", () => form.remove());
  form.addEventListener("pk-done", () => form.close());
});
