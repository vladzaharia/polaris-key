// The software facts a browser report carries (`POST /<p>/devices/report`, the Worker's
// `REPORT_KEYS`). Only what the page states about itself: the coarse OS family the browser
// reports, the logical core count and the device-memory bucket the browser already exposes, the
// locale and the time zone. No fingerprinting surface (canvas, WebGL, fonts) is read, ever
// (docs/PRIVACY.md).

import type { JSONValue } from "@polaris-key/protocol/core";

/** What the reader looks at; the page's globals by default (tests pass a fake). */
export interface BrowserFactsEnvironment {
  navigator?: {
    userAgent?: string;
    language?: string;
    hardwareConcurrency?: number;
    deviceMemory?: number;
    userAgentData?: { platform?: string };
  };
  timeZone?: string;
}

const OS_FAMILIES: [RegExp, string][] = [
  [/windows/i, "windows"],
  [/android/i, "android"],
  [/iphone|ipad|ipod|ios/i, "ios"],
  [/mac ?os|macintosh/i, "macos"],
  [/cros/i, "chromeos"],
  [/linux/i, "linux"],
];

function osFamily(env: BrowserFactsEnvironment): string {
  const hint =
    env.navigator?.userAgentData?.platform ?? env.navigator?.userAgent ?? "";
  for (const [re, name] of OS_FAMILIES) if (re.test(hint)) return name;
  return "unknown";
}

/** The report's facts for this page. Never throws; an unreadable value is simply absent. */
export function browserFacts(
  env: BrowserFactsEnvironment = pageEnvironment(),
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = { os: { name: osFamily(env) } };
  const nav = env.navigator;
  const hardware: Record<string, JSONValue> = {};
  if (
    typeof nav?.hardwareConcurrency === "number" &&
    nav.hardwareConcurrency > 0
  )
    hardware.cpuCores = Math.floor(nav.hardwareConcurrency);
  if (typeof nav?.deviceMemory === "number" && nav.deviceMemory > 0)
    hardware.ramMb = Math.round(nav.deviceMemory * 1024);
  if (Object.keys(hardware).length > 0) out.hardware = hardware;
  out.runtime = { name: "browser", version: "web" };
  if (nav?.language) out.locale = nav.language;
  if (env.timeZone) out.timezone = env.timeZone;
  return out;
}

function pageEnvironment(): BrowserFactsEnvironment {
  const g = globalThis as { navigator?: BrowserFactsEnvironment["navigator"] };
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  return { navigator: g.navigator, timeZone };
}
