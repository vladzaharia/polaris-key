import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type AttestationVerdictDto,
  type ProductDeviceDetail,
} from "../../api.js";
import { errorCopy } from "../../lib/errorCopy.js";
import { fromSeconds } from "../../lib/format.js";
import { confirmFor } from "../../lib/actions.js";
import { Button } from "../../ui/Button.js";
import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../ui/DescriptionList.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../ui/Drawer.js";
import { ErrorState } from "../../ui/ErrorState.js";
import { Hash } from "../../ui/Hash.js";
import { Skeleton } from "../../ui/Skeleton.js";
import { StatusPill } from "../../ui/StatusPill.js";
import { Timestamp } from "../../ui/Timestamp.js";
import { toast } from "../../ui/toast.js";
import { mutate } from "../data/mutations.js";
import { qk } from "../data/queries.js";
import { queryClient } from "../data/queryClient.js";
import { EntityLink } from "./EntityLink.js";

/** Read one device through the product route: it reaches licensed and license-free devices. */
export function fetchDevice(
  slug: string,
  deviceId: string,
): Promise<ProductDeviceDetail> {
  return api.productDevice(slug, deviceId);
}

function intent(action: "device.deauthorize" | "device.resetBinding") {
  const i = confirmFor(action).intent;
  return i === "none" ? "neutral" : i;
}

/**
 * The device drawer (docs/design/ADMIN.md §2.3 "Devices; drawer routed", §6.5.2): every fact
 * the server keeps about one device, as visible text (DEV-3, LDT-15): status, license and seat,
 * trust level and the last attestation verdict, platform, app and SDK, OS build and kernel,
 * hardware, runtime, locale, probes and the fingerprint's components.
 *
 * Routed: the caller passes the device id from the URL (`devices/:deviceId`) and closes by
 * navigating, so the drawer is linkable and Back closes it. A load error offers Retry (DEV-2).
 * Actions sit in the footer and appear only when they apply: Reset binding with a fingerprint
 * (L1), Deauthorize while authorized (L2).
 */
export function DeviceDrawer({
  slug,
  deviceId,
  onClose,
  now,
}: {
  slug: string;
  deviceId: string | null | undefined;
  onClose: () => void;
  now?: number;
}): React.ReactElement {
  const open = !!deviceId;
  const query = useQuery(
    {
      queryKey: qk.device(slug, deviceId ?? ""),
      queryFn: () => fetchDevice(slug, deviceId!),
      enabled: open,
    },
    queryClient,
  );
  const [confirm, setConfirm] = React.useState<"deauthorize" | "reset" | null>(
    null,
  );
  const d = query.data;
  const title = d?.label || deviceId || "Device";
  const licenseFree = d != null && d.licenseId === null;

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
        title={title}
        description={
          d?.label ? <span className="font-mono">{d.deviceId}</span> : "Device"
        }
        size="lg"
      >
        <DrawerBody>
          {query.isPending && open ? (
            <div className="space-y-3" aria-label="Loading device">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : query.isError ? (
            <ErrorState
              error={query.error}
              context={{ thing: "Device" }}
              onRetry={() => void query.refetch()}
            />
          ) : d ? (
            <DeviceFacts slug={slug} device={d} now={now} />
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {d?.fingerprint ? (
            <Button variant="outline" onClick={() => setConfirm("reset")}>
              Reset binding…
            </Button>
          ) : null}
          {d?.status === "authorized" ? (
            <Button variant="danger" onClick={() => setConfirm("deauthorize")}>
              Deauthorize…
            </Button>
          ) : null}
        </DrawerFooter>
      </Drawer>

      <ConfirmDialog
        open={confirm === "deauthorize"}
        onOpenChange={(o) => !o && setConfirm(null)}
        intent={intent("device.deauthorize")}
        title={`Deauthorize ${title}?`}
        consequences={
          licenseFree
            ? [
                "The device loses access and its token is revoked.",
                "It holds no license, so no seat is freed.",
                "Under open registration it can register again on its next start.",
              ]
            : [
                "The device loses access and its token is revoked.",
                "Its seat on the license is freed.",
                "To use the license again it must re-activate.",
              ]
        }
        confirmLabel="Deauthorize"
        describeError={(e) => errorCopy(e, { thing: "Device" })}
        onConfirm={async () => {
          await mutate("deauthorizeProductDevice", slug, deviceId!);
          toast.success("Device deauthorized");
        }}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => !o && setConfirm(null)}
        intent={intent("device.resetBinding")}
        title={`Reset the hardware binding of ${title}?`}
        consequences={[
          "The device stays authorized.",
          "Its next check-in binds to the hardware it reports then, which clears a false hardware-change lockout.",
        ]}
        confirmLabel="Reset binding"
        describeError={(e) => errorCopy(e, { thing: "Device" })}
        onConfirm={async () => {
          await mutate("resetProductDeviceFingerprint", slug, deviceId!);
          toast.success("Hardware binding cleared", {
            description: "It binds again on the next check-in.",
          });
        }}
      />
    </>
  );
}

function verdictText(v: AttestationVerdictDto | null | undefined): string {
  if (!v) return "No attestation recorded";
  const kind =
    v.kind === "app-attest"
      ? "App Attest"
      : v.kind === "play-integrity"
        ? "Play Integrity"
        : (v.kind ?? "Attestation");
  if (v.outcome === "attested") return `${kind}: attested`;
  if (v.outcome === "rejected")
    return `${kind}: rejected${v.reason ? `, ${v.reason}` : ""}`;
  return `${kind}: ${v.outcome ?? "no outcome"}`;
}

const dash = "—";
const join = (...parts: (string | number | null | undefined)[]): string =>
  parts.filter((p) => p !== undefined && p !== null && p !== "").join(" ") ||
  dash;

function DeviceFacts({
  slug,
  device: d,
  now,
}: {
  slug: string;
  device: ProductDeviceDetail;
  now?: number;
}): React.ReactElement {
  const facts = d.facts;
  const fp = d.fingerprint;
  const probes = Object.entries(facts?.probes ?? {});
  const components = Object.entries(fp?.components ?? {});
  return (
    <div className="space-y-6">
      <section aria-labelledby="device-status" className="space-y-3">
        <h3 id="device-status" className="text-sm font-bold text-fg-strong">
          Status
        </h3>
        <DescriptionList
          columns={2}
          items={[
            {
              term: "Status",
              detail: <StatusPill domain="device" state={d.status} />,
            },
            {
              term: "License",
              detail: d.licenseId ? (
                <>
                  <EntityLink slug={slug} kind="license" id={d.licenseId} />
                  {d.seatNo != null ? (
                    <span className="text-fg-muted"> · seat {d.seatNo}</span>
                  ) : null}
                </>
              ) : (
                "License-free: registered without a license"
              ),
            },
            {
              term: "Trust level",
              detail:
                d.trustLevel === "attested" ? (
                  <StatusPill tone="success">Attested</StatusPill>
                ) : (
                  <StatusPill tone="neutral" icon={null}>
                    Basic
                  </StatusPill>
                ),
              help:
                d.trustLevel === "attested" && d.attestedAt ? (
                  <>
                    Attested{" "}
                    <Timestamp at={fromSeconds(d.attestedAt)} now={now} />
                  </>
                ) : (
                  "Basic is expected for web, desktop and sideloaded builds."
                ),
            },
            {
              term: "Last attestation verdict",
              detail: verdictText(d.lastVerdict),
            },
            {
              term: "First seen",
              detail: (
                <Timestamp
                  at={fromSeconds(d.firstSeen)}
                  format="detail"
                  now={now}
                />
              ),
            },
            {
              term: "Last seen",
              detail: (
                <Timestamp
                  at={fromSeconds(d.lastSeen)}
                  format="detail"
                  now={now}
                />
              ),
              help: "The most recent check-in, not a presence indicator.",
            },
          ]}
        />
      </section>

      <section aria-labelledby="device-software" className="space-y-3">
        <h3 id="device-software" className="text-sm font-bold text-fg-strong">
          Software
        </h3>
        <DescriptionList
          columns={2}
          items={[
            {
              term: "Platform",
              detail: join(d.platform, d.arch && `· ${d.arch}`),
            },
            {
              term: "App version",
              detail: (
                <span className="font-mono text-xs">
                  {d.appVersion ?? dash}
                </span>
              ),
            },
            { term: "SDK", detail: join(d.sdkName, d.sdkVersion) },
            {
              term: "Operating system",
              detail: join(facts?.os.name, facts?.os.version),
              help:
                facts?.os.build || facts?.os.kernel
                  ? join(
                      facts.os.build && `build ${facts.os.build}`,
                      facts.os.kernel && `· kernel ${facts.os.kernel}`,
                    )
                  : undefined,
            },
            {
              term: "Runtime",
              detail: join(facts?.runtime.name, facts?.runtime.version),
            },
            {
              term: "Locale",
              detail: join(
                facts?.locale,
                facts?.timezone && `· ${facts.timezone}`,
              ),
            },
            ...(d.ua
              ? [
                  {
                    term: "User agent",
                    detail: <span className="font-mono text-xs">{d.ua}</span>,
                  },
                ]
              : []),
          ]}
        />
      </section>

      <section aria-labelledby="device-hardware" className="space-y-3">
        <h3 id="device-hardware" className="text-sm font-bold text-fg-strong">
          Hardware
        </h3>
        <DescriptionList
          columns={2}
          items={[
            { term: "Model", detail: facts?.hardware.machineModel ?? dash },
            { term: "CPU", detail: facts?.hardware.cpuModel ?? dash },
            {
              term: "Cores",
              detail:
                facts?.hardware.cpuCores != null
                  ? String(facts.hardware.cpuCores)
                  : dash,
            },
            {
              term: "Memory",
              detail:
                facts?.hardware.ramMb != null
                  ? `${(facts.hardware.ramMb / 1024).toFixed(1)} GB`
                  : dash,
            },
          ]}
        />
        {probes.length ? (
          <div>
            <h4 className="mb-1 text-xs font-bold text-fg-muted">Probes</h4>
            <ul className="space-y-1">
              {probes.map(([id, p]) => (
                <li key={id} className="flex flex-wrap gap-2 text-sm">
                  <span className="font-mono text-xs">{id}</span>
                  <span className="text-fg-muted">
                    {p.present
                      ? `present${p.version ? `, ${p.version}` : ""}`
                      : "not present"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="device-fingerprint" className="space-y-3">
        <h3
          id="device-fingerprint"
          className="text-sm font-bold text-fg-strong"
        >
          Hardware binding
        </h3>
        {!fp ? (
          <p className="text-fg-muted">
            No binding: this device has not sent a fingerprint.
          </p>
        ) : (
          <>
            <DescriptionList
              columns={2}
              items={[
                {
                  term: "Binding",
                  detail: (
                    <StatusPill
                      domain="fingerprint"
                      state={
                        fp.status === "unverified"
                          ? "unverified"
                          : (fp.lastDriftCount ?? 0) > 0
                            ? "drifted"
                            : "verified"
                      }
                    />
                  ),
                },
                {
                  term: "Hardware id",
                  detail: fp.hwid ? (
                    <Hash value={fp.hwid} label="hardware id" />
                  ) : (
                    dash
                  ),
                },
                {
                  term: "Components",
                  detail: String(fp.componentCount),
                },
                {
                  term: "Last change",
                  detail: fp.lastDriftAt ? (
                    <>
                      <Timestamp at={fromSeconds(fp.lastDriftAt)} now={now} />
                      {fp.lastDriftCount
                        ? ` · ${fp.lastDriftCount} ${fp.lastDriftCount === 1 ? "component" : "components"}`
                        : ""}
                    </>
                  ) : (
                    "None recorded"
                  ),
                },
              ]}
            />
            {components.length ? (
              <ul className="space-y-1">
                {components.map(([name, value]) => (
                  <li
                    key={name}
                    className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-2"
                  >
                    <span className="text-fg-muted">{name}</span>
                    <span className="break-all font-mono text-xs">{value}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
