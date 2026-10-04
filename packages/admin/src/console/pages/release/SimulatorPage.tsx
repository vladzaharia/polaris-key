import * as React from "react";
import { platformLabel } from "@polaris-key/manifest";
import { BINARY_METHODS } from "@polaris-key/protocol/update";
import type {
  SimulateParams,
  SimulateResponse,
  SimulatedPackDto,
  SimulatedReleaseDto,
} from "../../../api.js";
import { label, OUTLET_KIND_LABELS } from "../../../lib/labels.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Combobox } from "../../../ui/Combobox.js";
import { CopyButton } from "../../../ui/CopyButton.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { Hash } from "../../../ui/Hash.js";
import { Input } from "../../../ui/Input.js";
import { Select } from "../../../ui/Select.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { PageHeader } from "../../components/PageHeader.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { useProduct } from "../../data/hooks.js";
import { navigate, useLocation } from "../../router.js";
import { r } from "../../routes.js";
import { CompatTabs, HowToRead } from "./CompatibilityPage.js";
import {
  useDeliverables,
  useMatrixOverlay,
  useReleaseChannels,
  useReleaseStore,
  useSimulation,
} from "./data.js";
import { APP } from "./shared.js";

/**
 * Release → Compatibility → Simulator (ADMIN.md §6.3.5, T6 single step; CMP-8 to CMP-10): what a
 * fresh device running one app release gets. The worker runs client-core's own update check, so
 * the console renders its answer and never recomputes it.
 *
 * Inputs live in the URL (sharable). The form is a draft: Simulate writes it to the URL, which
 * runs the query; while the draft differs from the URL the old result is cleared, so a stale
 * answer never sits beside changed inputs (CMP-9).
 */

interface Draft {
  app: string;
  platform: string;
  outlet: string;
  channel: string;
  /** Axis → value, from the selects. */
  axes: Record<string, string>;
  /** Free-text variant (`axis=value;…`), used when no axis select is set. */
  variant: string;
  device: string;
  packSet: string;
  methods: string[];
}

const KEYS = [
  "app",
  "platform",
  "outlet",
  "channel",
  "variant",
  "device",
  "packSet",
  "methods",
] as const;

function draftFromQuery(q: URLSearchParams): Draft {
  const variant = q.get("variant") ?? "";
  const axes: Record<string, string> = {};
  for (const pair of variant.split(";").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (k && v && !v.includes(",")) axes[k] = v;
  }
  return {
    app: q.get("app") ?? "",
    platform: q.get("platform") ?? "",
    outlet: q.get("outlet") ?? "",
    channel: q.get("channel") ?? "",
    axes,
    variant,
    device: q.get("device") ?? "",
    packSet: q.get("packSet") ?? "",
    methods: (q.get("methods") ?? "").split(",").filter(Boolean),
  };
}

function variantOf(d: Draft): string {
  const fromAxes = Object.entries(d.axes)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
  return fromAxes || d.variant.trim();
}

function queryOf(d: Draft): Record<string, string> {
  return {
    app: d.app,
    platform: d.platform,
    outlet: d.outlet,
    channel: d.channel,
    variant: variantOf(d),
    device: d.device.trim(),
    packSet: d.packSet.trim(),
    methods: d.methods.join(","),
  };
}

function paramsOf(q: Record<string, string>): SimulateParams | null {
  if (!q.app || !q.platform) return null;
  return {
    appRelease: q.app,
    platform: q.platform,
    ...(q.outlet ? { outlet: q.outlet } : {}),
    ...(q.channel ? { channel: q.channel } : {}),
    ...(q.variant ? { variant: q.variant } : {}),
    ...(q.device ? { device: q.device } : {}),
    ...(q.packSet ? { packSetId: q.packSet } : {}),
    ...(q.methods ? { methods: q.methods } : {}),
  };
}

const same = (a: Record<string, string>, b: Record<string, string>): boolean =>
  KEYS.every((k) => (a[k] ?? "") === (b[k] ?? ""));

/** The axes the packs' variants use, from their `axis=value;…` keys. */
export function variantAxes(keys: string[]): Map<string, string[]> {
  const axes = new Map<string, Set<string>>();
  for (const key of keys) {
    for (const pair of key.split(";").filter(Boolean)) {
      const [k, v] = pair.split("=");
      if (!k || !v) continue;
      axes.set(k, (axes.get(k) ?? new Set()).add(v));
    }
  }
  return new Map([...axes].map(([k, v]) => [k, [...v].sort()]));
}

const rel = (x: SimulatedReleaseDto | null): string => (x ? x.version : "none");

function decisionLine(d: SimulateResponse["decision"]): {
  label: string;
  reason: string | null;
  tone: "success" | "warning" | "danger" | "neutral";
} {
  if (!d) return { label: "No decision", reason: null, tone: "neutral" };
  const reason = typeof d.reason === "string" ? d.reason : null;
  const action = String(d.action);
  const tone =
    action === "none" || action === "up-to-date"
      ? "success"
      : action === "block" || typeof d.contentBlock === "string"
        ? "danger"
        : "warning";
  return {
    label: action.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    reason,
    tone,
  };
}

function PackRow({ p }: { p: SimulatedPackDto }): React.ReactElement {
  return (
    <tr className="border-b border-border align-top" data-pack={p.pack}>
      <th scope="row" className="px-3 py-2 text-left font-normal">
        <span className="font-mono text-xs">{p.pack}</span>
        {p.declared?.required ? (
          <span className="ml-1 text-xs text-fg-muted">required</span>
        ) : null}
      </th>
      <td className="px-3 py-2">
        <div>
          {p.declared ? p.declared.binding : "undeclared"}
          {p.effectiveBinding && p.effectiveBinding !== p.declared?.binding
            ? ` → ${p.effectiveBinding}`
            : ""}
        </div>
        <div className="text-xs text-fg-muted">{p.reason.detail}</div>
      </td>
      <td className="px-3 py-2">
        <div className="font-mono text-xs">{rel(p.feedTarget)}</div>
        {p.gate ? (
          <div className="text-xs text-fg-muted">
            {p.gate.halted
              ? "Rollout halted"
              : p.gate.rollout
                ? `Rollout ${p.gate.rollout.bp / 100} %`
                : "No rollout gate"}
            {p.gate.bucket !== null ? ` · bucket ${p.gate.bucket}` : ""}
            {p.gate.takesTarget
              ? " · takes it"
              : ` · falls back to ${rel(p.gate.fallback)}`}
          </div>
        ) : null}
        {p.unsatisfied.map((u) => (
          <div
            key={`${u.reason}:${u.variant}`}
            className="text-xs text-warning"
          >
            Unsatisfied: {u.reason} ({u.detail})
          </div>
        ))}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {p.floor ? `≥ ${p.floor.minVersion}` : "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        {p.expected
          ? `${p.expected.required ? "Required" : "Optional"} · ${p.expected.delivery}`
          : "—"}
      </td>
      <td className="px-3 py-2">
        <div className="font-mono text-xs">
          {rel(p.runs)}
          {p.active && p.active.sha256 !== p.runs?.sha256 ? (
            <span className="font-sans text-fg-muted">
              {" "}
              (active {p.active.version})
            </span>
          ) : null}
        </div>
        {p.install ? (
          <div className="text-xs text-fg-muted">
            Installs {p.install.version}
          </div>
        ) : null}
        {p.revoke ? <div className="text-xs text-danger">Unmounted</div> : null}
        {p.revocations.map((v) => (
          <div key={v.record} className="text-xs text-danger">
            {v.kind === "delegation"
              ? `Content key revoked: ${v.reason}`
              : `${v.version} revoked: ${v.reason}${v.replacement ? "" : " (no replacement)"}`}
          </div>
        ))}
      </td>
    </tr>
  );
}

function Result({ r: res }: { r: SimulateResponse }): React.ReactElement {
  const d = decisionLine(res.decision);
  return (
    <section aria-label="Simulation result" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-fg-strong">Result</h2>
        <CopyButton
          value={JSON.stringify(res, null, 2)}
          label="Copy result as JSON"
          showLabel
        />
      </div>
      <DescriptionList
        columns={2}
        items={[
          {
            term: "Decision",
            detail: (
              <span
                className="inline-flex flex-wrap items-center gap-2"
                data-testid="sim-decision"
              >
                <StatusPill tone={d.tone}>{d.label}</StatusPill>
                {res.decision &&
                typeof res.decision.contentBlock === "string" ? (
                  <span className="text-xs">
                    content block {res.decision.contentBlock}
                  </span>
                ) : null}
              </span>
            ),
            help: d.reason ? `Because: ${d.reason}` : undefined,
          },
          {
            term: "Device",
            detail: [
              `${res.selector.version} on ${platformLabel(res.selector.platform)}`,
              res.selector.outlet ? `via ${res.selector.outlet.id}` : null,
              `channel ${res.selector.channel}`,
              res.selector.contentApi !== null
                ? `contentApi ${res.selector.contentApi}`
                : null,
              res.selector.engine,
            ]
              .filter(Boolean)
              .join(" · "),
            help: [
              res.selector.build
                ? `Build ${res.selector.build.id} (${res.selector.build.arch}, ${res.selector.build.format})`
                : "No build for this platform",
              Object.keys(res.selector.axes).length
                ? `axes ${Object.entries(res.selector.axes)
                    .map(([k, v]) => `${k}=${v.join(",")}`)
                    .join("; ")}`
                : null,
              `methods ${res.selector.methods.join(", ") || "download"}`,
            ]
              .filter(Boolean)
              .join(" · "),
          },
          {
            term: "Feed",
            detail: [
              res.feed.composable ? "Composable" : "Not composable",
              res.feed.target ? `target ${res.feed.target.version}` : null,
              res.feed.appRollout?.bucket !== null &&
              res.feed.appRollout?.bucket !== undefined
                ? `bucket ${res.feed.appRollout.bucket}`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
            help:
              [
                res.feed.appRollout?.rollout
                  ? `App rollout ${res.feed.appRollout.rollout.bp / 100} %`
                  : null,
                res.feed.appRollout?.halted ? "app rollout halted" : null,
                res.feed.omitted.length
                  ? `left out: ${res.feed.omitted.join(", ")}`
                  : null,
                res.feed.deltas
                  ? `delta menu: ${res.feed.deltas} ${res.feed.deltas === 1 ? "entry" : "entries"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
          },
          {
            term: "Pack set",
            detail: res.packSetId ? (
              <span
                className="inline-flex flex-wrap items-center gap-2"
                data-testid="sim-packsetid"
              >
                <Hash value={res.packSetId} label="pack set id" />
                {res.reported ? (
                  res.reported.matches ? (
                    <StatusPill tone="success">Matches reported</StatusPill>
                  ) : (
                    <StatusPill tone="danger">Differs from reported</StatusPill>
                  )
                ) : null}
              </span>
            ) : (
              <span data-testid="sim-packsetid">None</span>
            ),
            help: res.set.length
              ? res.set.map((s) => `${s.pack} ${s.version}`).join(" · ")
              : "No pack in the set",
          },
          ...(res.activePackSetId && res.activePackSetId !== res.packSetId
            ? [
                {
                  term: "Active pack set",
                  detail: (
                    <Hash
                      value={res.activePackSetId}
                      label="active pack set id"
                    />
                  ),
                  help: "What the device runs before it installs the target set.",
                },
              ]
            : []),
          ...(res.boot ? [{ term: "Boot", detail: res.boot }] : []),
        ]}
      />
      {res.block ? (
        <Callout tone="danger" title="Blocked">
          {res.block}
        </Callout>
      ) : null}
      {res.packs.length ? (
        <div className="pk-scroll overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" aria-label="Packs">
            <thead className="border-b border-border text-left text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-bold">
                  Pack
                </th>
                <th scope="col" className="px-3 py-2 font-bold">
                  Binding
                </th>
                <th scope="col" className="px-3 py-2 font-bold">
                  Feed target
                </th>
                <th scope="col" className="px-3 py-2 font-bold">
                  Floor
                </th>
                <th scope="col" className="px-3 py-2 font-bold">
                  Expected
                </th>
                <th scope="col" className="px-3 py-2 font-bold">
                  Runs
                </th>
              </tr>
            </thead>
            <tbody>
              {res.packs.map((p) => (
                <PackRow key={p.pack} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {res.notes.length || res.errors.length ? (
        <div className="space-y-1">
          <h3 className="text-sm font-bold text-fg-strong">Notes</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs text-fg">
            {res.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {res.errors.map((e) => (
              <li key={`${e.code}:${e.detail ?? ""}`} className="text-danger">
                Check error: {e.code}
                {e.detail ? ` (${e.detail})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function SimulatorPage({ slug }: { slug: string }): React.ReactElement {
  const { route, hash } = useLocation();
  const queryString = route.query.toString();
  const submitted = React.useMemo(
    () => queryOf(draftFromQuery(new URLSearchParams(queryString))),
    [queryString],
  );
  const [draft, setDraft] = React.useState<Draft>(() =>
    draftFromQuery(new URLSearchParams(queryString)),
  );
  // A link that changes the URL (the matrix's "Simulate this device") re-seeds the draft.
  const lastQuery = React.useRef(queryString);
  React.useEffect(() => {
    if (queryString === lastQuery.current) return;
    lastQuery.current = queryString;
    setDraft(draftFromQuery(new URLSearchParams(queryString)));
  }, [queryString]);

  const store = useReleaseStore(slug);
  const channels = useReleaseChannels(slug);
  const deliverables = useDeliverables(slug);
  const product = useProduct(slug);
  const distributionOn =
    product.data?.services?.distribution?.enabled !== false;
  const overlay = useMatrixOverlay(slug, distributionOn);
  const params = paramsOf(submitted);
  const result = useSimulation(slug, params);

  const releases = (store.data?.releases ?? [])
    .filter((x) => x.deliverable === APP)
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  const app = releases.find((x) => x.releaseId === draft.app);
  const platforms = [
    ...new Set(
      (app?.builds ?? [])
        .map((b) => b.platform)
        .filter((p): p is string => !!p),
    ),
  ];
  // A platform from a shared link stays visible even when this release has no build for it.
  if (draft.platform && platforms.length && !platforms.includes(draft.platform))
    platforms.push(draft.platform);
  const appChannels =
    channels.data?.deliverables.find((d) => d.deliverable === APP)?.channels ??
    [];
  const axes = variantAxes(
    (deliverables.data?.deliverables ?? []).flatMap((d) => d.variantKeys),
  );
  const current = queryOf(draft);
  const stale = !same(current, submitted);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }));
  const packSetError =
    draft.packSet.trim() && !/^[0-9a-f]{64}$/.test(draft.packSet.trim())
      ? "A pack set id is 64 lowercase hex characters."
      : undefined;

  const simulate = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!draft.app || !draft.platform || packSetError) return;
    const q = new URLSearchParams(
      Object.entries(current).filter(([, v]) => v !== ""),
    ).toString();
    const path = hash.split("?")[0] || r.simulator(slug);
    navigate(`${path}${q ? `?${q}` : ""}`, { replace: true });
  };

  return (
    <div className="space-y-6" data-template="flow">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Compatibility", to: r.compatibility(slug) },
              { label: "Simulator" },
            ]}
          />
        }
        title="Update simulator"
        description="Runs the update check a fresh device runs, the same code the SDKs use, against what each channel serves now. Nothing is stored."
        meta={<HowToRead />}
        tabs={<CompatTabs slug={slug} value="simulator" />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <form
          onSubmit={simulate}
          aria-label="Simulator inputs"
          className="space-y-4 rounded-lg border border-border bg-surface-raised p-4"
          noValidate
        >
          <FormField
            name="sim-app"
            label={
              <>
                App release
                <span className="text-xs font-normal text-fg-subtle">
                  Required
                </span>
              </>
            }
            help="The version the device runs. Every release in the store is listed."
            value={draft.app || null}
            onChange={(v: string | null) =>
              setDraft((d) => ({ ...d, app: v ?? "", platform: "" }))
            }
          >
            {(f) => (
              <Combobox
                {...f}
                options={releases.map((x) => ({
                  value: x.releaseId,
                  label: x.version,
                  secondary: [x.channel, x.yank ? "Yanked" : null]
                    .filter(Boolean)
                    .join(" · "),
                }))}
                placeholder={
                  store.isPending ? "Loading releases…" : "Choose a release"
                }
                searchPlaceholder="Search versions"
                emptyText="No release matches."
              />
            )}
          </FormField>
          <FormField
            name="sim-platform"
            label="Platform"
            required
            help={
              app && platforms.length === 0
                ? "This release declares no builds; type the platform."
                : "From the release's builds."
            }
            value={draft.platform}
            onChange={(v: string | null) => set("platform", v ?? "")}
          >
            {(f) =>
              app && platforms.length === 0 ? (
                <Input {...f} mono placeholder="macos" />
              ) : (
                <Select
                  {...f}
                  disabled={!app}
                  options={platforms.map((p) => ({
                    value: p,
                    label: platformLabel(p),
                  }))}
                  placeholder={
                    app ? "Choose a platform" : "Choose a release first"
                  }
                />
              )
            }
          </FormField>
          {distributionOn ? (
            <FormField
              name="sim-outlet"
              label="Outlet"
              help="Where the device installed the app from; none means the device does not say."
              value={draft.outlet || null}
              onChange={(v: string | null) => set("outlet", v ?? "")}
            >
              {(f) => (
                <Select
                  {...f}
                  allowEmpty
                  emptyLabel="None detected"
                  options={(overlay.data?.outlets ?? []).map((o) => ({
                    value: o.outletId,
                    label: o.outletId,
                    description: label(OUTLET_KIND_LABELS, o.kind),
                  }))}
                />
              )}
            </FormField>
          ) : null}
          <FormField
            name="sim-channel"
            label="Channel"
            help="The channel the device follows (stable when left empty)."
            value={draft.channel || null}
            onChange={(v: string | null) => set("channel", v ?? "")}
          >
            {(f) => (
              <Select
                {...f}
                allowEmpty
                emptyLabel="stable (default)"
                options={appChannels.map((c) => ({
                  value: c.channel,
                  label: c.channel,
                }))}
              />
            )}
          </FormField>
          {axes.size ? (
            <fieldset className="space-y-3">
              <legend className="text-sm font-bold text-fg-strong">
                Variant
              </legend>
              <p className="text-xs text-fg-muted">
                The device's variant per axis, as the packs declare them.
              </p>
              {[...axes].map(([axis, values]) => (
                <FormField
                  key={axis}
                  name={`sim-axis-${axis}`}
                  label={axis}
                  value={draft.axes[axis] ?? null}
                  onChange={(v: string | null) =>
                    setDraft((d) => ({
                      ...d,
                      axes: { ...d.axes, [axis]: v ?? "" },
                    }))
                  }
                >
                  {(f) => (
                    <Select
                      {...f}
                      allowEmpty
                      emptyLabel="Any"
                      options={values.map((v) => ({ value: v, label: v }))}
                    />
                  )}
                </FormField>
              ))}
            </fieldset>
          ) : (
            <FormField
              name="sim-variant"
              label="Variant"
              help="axis=value pairs separated by ';' (texture=etc2;tier=hd); a value may be a ',' preference list."
              value={draft.variant}
              onChange={(v: string) => set("variant", v)}
            >
              {(f) => <Input {...f} mono placeholder="texture=etc2;tier=hd" />}
            </FormField>
          )}
          <FormField
            name="sim-device"
            label="Device id"
            help="Optional. Puts the device in its rollout bucket, as the SDK's device id would."
            value={draft.device}
            onChange={(v: string) => set("device", v)}
          >
            {(f) => <Input {...f} mono placeholder="dev_…" />}
          </FormField>
          <FormField
            name="sim-packset"
            label="Reported pack set"
            help="Optional. The pack set id a device reported, to compare with the expected one."
            value={draft.packSet}
            onChange={(v: string) => set("packSet", v)}
            error={packSetError}
          >
            {(f) => <Input {...f} mono placeholder="64 hex characters" />}
          </FormField>
          <fieldset className="space-y-2">
            <legend className="text-sm font-bold text-fg-strong">
              Update methods
            </legend>
            <p className="text-xs text-fg-muted">
              The binary update methods the device supports (download when none
              is ticked).
            </p>
            {BINARY_METHODS.map((m) => (
              <Checkbox
                key={m}
                checked={draft.methods.includes(m)}
                onCheckedChange={(on) =>
                  setDraft((d) => ({
                    ...d,
                    methods: on
                      ? [...d.methods, m].filter(
                          (x, i, a) => a.indexOf(x) === i,
                        )
                      : d.methods.filter((x) => x !== m),
                  }))
                }
                label={m}
              />
            ))}
          </fieldset>
          <Button
            type="submit"
            className="w-full"
            loading={result.isFetching}
            disabledReason={
              !draft.app
                ? "Choose an app release."
                : !draft.platform
                  ? "Choose a platform."
                  : undefined
            }
          >
            Simulate
          </Button>
        </form>
        <div className="min-w-0">
          {!params ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-sm text-fg-muted">
              Choose an app release and a platform, then Simulate to see what
              that device is offered.
            </div>
          ) : stale ? (
            <div
              aria-live="polite"
              className="space-y-3 rounded-lg border border-dashed border-border p-6"
            >
              <p className="text-sm text-fg-muted">
                The inputs changed. Simulate to see the result for them.
              </p>
              <Skeleton className="h-24 w-full" />
            </div>
          ) : result.isPending || (result.isFetching && !result.data) ? (
            <Skeleton className="h-64 w-full" />
          ) : result.error ? (
            <ErrorState
              error={result.error}
              onRetry={() => void result.refetch()}
            />
          ) : result.data ? (
            <Result r={result.data} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
