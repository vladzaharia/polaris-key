/**
 * The fields the Worker always sends on a licence (holder, deletion verdict, the device limit it
 * enforces and its source, every term with its layer), for the mocked backends: the console reads
 * them as given. A field the fixture sets itself is kept.
 */
export function workerFields<T extends object>(
  l: T,
): T & Record<string, unknown> {
  const f = l as Record<string, unknown>;
  const email = String(f.email ?? "").trim();
  const owner = f.ownerSubject as string | null | undefined;
  const holder =
    f.holder ??
    (!email && !owner
      ? { kind: "floating" }
      : {
          kind: "assigned",
          inAccount: Boolean(owner),
          ...(email ? { email } : {}),
        });
  const own = (f.deviceLimit as number | null | undefined) ?? null;
  const inheritedDeviceLimit =
    (f.inheritedDeviceLimit as number | undefined) ?? 3;
  const inheritedDeviceLimitSource = f.inheritedDeviceLimitSource ?? "product";
  const effectiveDeviceLimit =
    (f.effectiveDeviceLimit as number | undefined) ??
    own ??
    inheritedDeviceLimit;
  const deviceLimitSource =
    f.deviceLimitSource ??
    (own !== null ? "license" : inheritedDeviceLimitSource);
  const channels = (f.channels as string[] | undefined) ?? [];
  const tier = (f.tier as string | null | undefined) ?? null;
  const terms = f.terms ?? {
    deviceLimit: { value: effectiveDeviceLimit, source: deviceLimitSource },
    inheritedDeviceLimit: {
      value: inheritedDeviceLimit,
      source: inheritedDeviceLimitSource,
    },
    maxOfflineDays: {
      value: (f.maxOfflineDays as number | null | undefined) ?? 14,
      source: f.maxOfflineDays != null ? "license" : "product",
    },
    channels: { value: channels, source: channels.length ? "license" : "none" },
    minVersion: {
      value: f.minVersion ?? null,
      source: f.minVersion ? "license" : "none",
    },
    maxVersion: {
      value: f.maxVersion ?? null,
      source: f.maxVersion ? "license" : "none",
    },
    fingerprintMode: { value: "normal", source: tier ? "tier" : "product" },
  };
  return {
    deletion: { allowed: true, reasons: [] },
    ...l,
    holder,
    effectiveDeviceLimit,
    deviceLimitSource,
    inheritedDeviceLimit,
    inheritedDeviceLimitSource,
    seatDeviceCount: f.seatDeviceCount ?? f.deviceCount ?? 0,
    configOverrides: f.configOverrides ?? {
      owned: false,
      ownerSubject: null,
      signUpUrl: null,
    },
    terms,
  };
}
