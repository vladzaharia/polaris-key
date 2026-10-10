// The terminal kit's views, moved here from @polaris-key/node's CLI (UK-14): the Node terminal's
// golden renders (packages/sdk-node/test/cli/golden) prove them byte for byte; these pin the
// shared rules they keep with the matrix models.

import { describe, expect, it } from "vitest";

import { parseKey, viewOf } from "../src/index.js";
import {
  activationOutcome,
  keyVerdict,
  KEY_SECRET_LENGTH,
  statusExit,
} from "../src/terminal.js";

const KEY = "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG";

describe("the terminal's views", () => {
  it("parse a key the way the Activate model does", () => {
    for (const [text, submitted] of [
      ["", false],
      ["pkey_tide", false],
      ["pkey_tidewater_Q2xv", false],
      ["pkey_tidewater_Q2xv", true],
      [KEY, false],
      ["tidewater-2024-pro", false],
    ] as const) {
      const terminal = keyVerdict(text, submitted).state;
      const model = viewOf("Activate", { keyField: { text, submitted } }).state;
      expect(terminal, text).toBe(model);
    }
    expect(KEY_SECRET_LENGTH).toBe(22);
    expect(parseKey(KEY).kind).toBe("parsed");
  });

  it("hand a device-limit refusal to DeviceLimit, never an error string", () => {
    const v = activationOutcome({
      kind: "device-limit",
      code: "device_limit",
      limit: 3,
      deviceCount: 3,
      manageUrl: "https://key.plrs.im/#/p/tidewater/free-device",
    });
    expect(v.state).toBe("device-limit");
    expect("deviceLimit" in v && v.deviceLimit.state).toBe("browser-mode");
  });

  it("exit 0 only when the app is usable", () => {
    expect(statusExit("ok")).toBe(0);
    expect(statusExit("grace")).toBe(0);
    expect(statusExit("revoked")).toBe(1);
  });
});
