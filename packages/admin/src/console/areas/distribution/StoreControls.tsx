/**
 * Store connector controls (ADMIN.md §6.4): App Store Connect, Google Play and the Microsoft
 * Store, from `GET …/distribution/connectors`.
 *
 * - **Rollout-shaped verbs** (App Store phased release pause, resume, complete; Play rollout
 *   fraction, halt, resume, complete) live in the Matrix cell drawer, beside the mirrored rollout
 *   they move (`StoreRolloutControls`).
 * - **Configuration actions** (App Store **Release this version**, **TestFlight public link**,
 *   **Webhook setup**; Play **Update priority** and **Settings**) live on the connector cards of
 *   Outlet credentials (`ConnectorCard`).
 *
 * Every control is the connector's own audited route; a store's refusal comes back as a reason
 * `errorCopy` words (`store_refused`, `not_held`, `credential_pin_missing`, …). Controls appear
 * only for a configured connector; an inert one says why.
 */

import * as React from "react";
import type {
  ConnectorStatusDto,
  MatrixRolloutDto,
  ReleaseStoreResponse,
} from "../../../api.js";
import { confirmFor, type ActionId } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { humanize } from "../../../lib/status.js";
import { Button } from "../../../ui/Button.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { Combobox } from "../../../ui/Combobox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput, numberRangeError } from "../../../ui/NumberInput.js";
import { Select } from "../../../ui/Select.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Switch } from "../../../ui/Switch.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";

const describe = (e: unknown) =>
  errorCopy(e, { area: "distribution", thing: "Store connector" });

/** One control call, confirmed at its §5.2 level. */
interface PendingControl {
  action: ActionId;
  control: string;
  title: string;
  consequences: string[];
  confirmLabel: string;
  body: Record<string, unknown>;
  done: string;
}

function ControlConfirm({
  slug,
  connector,
  pending,
  onClose,
  children,
  confirmDisabled,
  bodyExtra,
}: {
  slug: string;
  connector: string;
  pending: PendingControl | null;
  onClose: () => void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
  /** Fields the dialog's inputs add to the body at confirm time. */
  bodyExtra?: () => Record<string, unknown>;
}): React.ReactElement | null {
  if (!pending) return null;
  const policy = confirmFor(pending.action);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      intent={policy.intent === "none" ? "neutral" : policy.intent}
      title={pending.title}
      consequences={pending.consequences}
      confirmLabel={pending.confirmLabel}
      confirmDisabled={confirmDisabled}
      describeError={describe}
      onConfirm={async () => {
        await mutate("connectorControl", slug, connector, pending.control, {
          ...pending.body,
          ...(bodyExtra?.() ?? {}),
        });
        toast.success(pending.done);
        onClose();
      }}
    >
      {children}
    </ConfirmDialog>
  );
}

/** The Play track a rollout's (outlet, channel) maps to, from the connector's setup. */
function playTrack(
  connector: ConnectorStatusDto,
  rollout: MatrixRolloutDto,
): string | null {
  const outlets = (connector.setup?.outlets ?? []) as Array<{
    outletId: string;
    tracks?: Record<string, string>;
  }>;
  return (
    outlets.find((o) => o.outletId === rollout.outletId)?.tracks?.[
      rollout.channel
    ] ?? null
  );
}

/** Why a connector cannot act right now, or `null` when it can. */
export function connectorBlocked(c: ConnectorStatusDto): string | null {
  if (c.inert) return c.inert.message;
  if (!c.configured) return `${c.label} isn't configured for this product.`;
  return null;
}

/**
 * The store's own rollout verbs for a mirrored rollout, in the cell drawer. App Store Connect's
 * phased release, or Google Play's staged rollout.
 */
export function StoreRolloutControls({
  slug,
  connector,
  rollout,
  version,
}: {
  slug: string;
  connector: ConnectorStatusDto;
  rollout: MatrixRolloutDto;
  version: string;
}): React.ReactElement | null {
  const [pending, setPending] = React.useState<PendingControl | null>(null);
  const [fraction, setFraction] = React.useState<number | null>(
    rollout.rolloutBp / 10_000 || null,
  );
  const [confirmRollback, setConfirmRollback] = React.useState(false);
  if (!connector.configured && !connector.inert) return null;
  const blocked = connectorBlocked(connector);
  const has = (c: string) => connector.controls.includes(c);
  const where = `${version} on ${rollout.outletId}`;

  const buttons: { label: string; pending: PendingControl }[] = [];
  if (connector.kind === "asc") {
    const body = { releaseId: rollout.releaseId };
    if (has("phased-release/pause") && rollout.state === "active")
      buttons.push({
        label: "Pause phased release…",
        pending: {
          action: "connector.phasedPause",
          control: "phased-release/pause",
          title: `Pause the phased release of ${version}?`,
          consequences: [
            "App Store Connect stops adding users to the phased release.",
            "Users who already have it keep it. Resume continues the schedule.",
          ],
          confirmLabel: `Pause ${version}`,
          body,
          done: `Paused the phased release of ${where}`,
        },
      });
    if (has("phased-release/resume") && rollout.state === "paused")
      buttons.push({
        label: "Resume phased release…",
        pending: {
          action: "connector.phasedResume",
          control: "phased-release/resume",
          title: `Resume the phased release of ${version}?`,
          consequences: ["App Store Connect continues the 7-day schedule."],
          confirmLabel: `Resume ${version}`,
          body,
          done: `Resumed the phased release of ${where}`,
        },
      });
    if (has("phased-release/complete") && rollout.state !== "complete")
      buttons.push({
        label: "Release to everyone…",
        pending: {
          action: "connector.phasedComplete",
          control: "phased-release/complete",
          title: `Release ${version} to every App Store user?`,
          consequences: [
            "App Store Connect ends the phased release and offers the version to all users.",
            "This cannot be undone in App Store Connect.",
          ],
          confirmLabel: `Release ${version}`,
          body,
          done: `Released ${where} to every user`,
        },
      });
  } else if (connector.kind === "play") {
    const track = playTrack(connector, rollout);
    const body = track ? { track, releaseId: rollout.releaseId } : null;
    if (body) {
      if (has("rollout/fraction") && rollout.state !== "complete")
        buttons.push({
          label: "Set Play rollout…",
          pending: {
            action: "connector.storeFraction",
            control: "rollout/fraction",
            title: `Set the Play rollout of ${version}`,
            consequences: [
              `Google Play offers ${version} on the ${track} track to the share of users you set.`,
            ],
            confirmLabel: "Set rollout",
            body,
            done: `Set the Play rollout of ${where}`,
          },
        });
      if (has("rollout/halt") && rollout.state !== "halted")
        buttons.push({
          label: "Halt on Play…",
          pending: {
            action: "connector.storeHalt",
            control: "rollout/halt",
            title: `Halt ${version} on Google Play?`,
            consequences: [
              `Google Play stops offering ${version} on the ${track} track.`,
              "Users who installed it keep it. Resume continues the staged rollout.",
            ],
            confirmLabel: `Halt ${version}`,
            body,
            done: `Halted ${where} on Google Play`,
          },
        });
      if (has("rollout/resume") && rollout.state === "halted")
        buttons.push({
          label: "Resume on Play…",
          pending: {
            action: "connector.storeResume",
            control: "rollout/resume",
            title: `Resume ${version} on Google Play?`,
            consequences: [
              `Google Play offers ${version} on the ${track} track again.`,
            ],
            confirmLabel: `Resume ${version}`,
            body,
            done: `Resumed ${where} on Google Play`,
          },
        });
      if (has("rollout/complete") && rollout.state !== "complete")
        buttons.push({
          label: "Complete on Play…",
          pending: {
            action: "connector.storeComplete",
            control: "rollout/complete",
            title: `Complete the Play rollout of ${version}?`,
            consequences: [
              `Google Play offers ${version} to every user on the ${track} track.`,
              "A completed release cannot be staged again; halting it later rolls the track back.",
            ],
            confirmLabel: `Complete ${version}`,
            body,
            done: `Completed the Play rollout of ${where}`,
          },
        });
    }
  }

  if (buttons.length === 0 && !blocked) return null;
  const isFraction = pending?.control === "rollout/fraction";
  const isHalt = pending?.control === "rollout/halt";
  return (
    <div className="space-y-2 rounded-md bg-surface-sunken p-3">
      <p className="text-xs font-bold uppercase tracking-wider text-fg-muted">
        Store controls · {connector.label}
      </p>
      {blocked ? (
        <p className="text-sm text-fg-muted">{blocked}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {buttons.map((b) => (
            <Button
              key={b.label}
              size="sm"
              variant={
                confirmFor(b.pending.action).level >= 2 ? "danger" : "outline"
              }
              onClick={() => setPending(b.pending)}
            >
              {b.label}
            </Button>
          ))}
        </div>
      )}
      <ControlConfirm
        slug={slug}
        connector={connector.kind}
        pending={pending}
        onClose={() => {
          setPending(null);
          setConfirmRollback(false);
        }}
        confirmDisabled={
          isFraction
            ? numberRangeError(fraction, {
                min: 0.01,
                max: 99.99,
                percent: true,
                required: true,
              }) !== null
            : false
        }
        bodyExtra={() =>
          isFraction
            ? { userFraction: fraction }
            : isHalt && rollout.state === "complete"
              ? { confirmRollback }
              : {}
        }
      >
        {isFraction ? (
          <FormField<number | null>
            name="play-fraction"
            label="Share of users"
            required
            value={fraction}
            onChange={setFraction}
            help="More than 0 % and less than 100 %. Use Complete for everyone."
          >
            {(field) => (
              <NumberInput
                id={field.id}
                value={fraction}
                onChange={setFraction}
                percent
                min={0.01}
                max={99.99}
                step="any"
                aria-describedby={field["aria-describedby"]}
              />
            )}
          </FormField>
        ) : isHalt && rollout.state === "complete" ? (
          <Checkbox
            checked={confirmRollback}
            onCheckedChange={setConfirmRollback}
            label="Roll the track back to the previously completed release"
            description="Halting a completed release on Google Play reverts the track."
          />
        ) : null}
      </ControlConfirm>
    </div>
  );
}

const CREDENTIAL_SOURCE: Record<string, string> = {
  own: "This product's own key",
  product: "This product's own key",
  platform: "The platform's team key",
};

/** The facts a connector's setup reports, in words (ids only, never a credential value). */
function setupFacts(
  c: ConnectorStatusDto,
): { term: string; detail: React.ReactNode }[] {
  const s = c.setup ?? {};
  const facts: { term: string; detail: React.ReactNode }[] = [];
  const mono = (v: unknown) => (
    <span className="font-mono text-xs">{String(v)}</span>
  );
  const add = (term: string, v: unknown) => {
    if (v !== null && v !== undefined && v !== "")
      facts.push({ term, detail: mono(v) });
  };
  add("App Store app id", s.appleId);
  add("Bundle id", s.bundleId);
  add("App Store outlet", s.appStoreOutlet);
  add("TestFlight outlet", s.testflightOutlet);
  add("API key credential", s.apiKeyCredential);
  add("Webhook secret credential", s.webhookSecretCredential);
  add("Package name", s.packageName);
  add("Credential", s.credential);
  add("Store ID", s.productId);
  if (c.credentialSource)
    facts.push({
      term: "Key in use",
      detail:
        CREDENTIAL_SOURCE[c.credentialSource] ?? humanize(c.credentialSource),
    });
  return facts;
}

/**
 * One store connector on Outlet credentials: its status and its configuration actions. The
 * rollout verbs stay in the Matrix cell drawer.
 */
export function ConnectorCard({
  slug,
  connector,
  releases,
}: {
  slug: string;
  connector: ConnectorStatusDto;
  releases: ReleaseStoreResponse | undefined;
}): React.ReactElement {
  const [pending, setPending] = React.useState<PendingControl | null>(null);
  const [releaseId, setReleaseId] = React.useState<string | null>(null);
  const [groupId, setGroupId] = React.useState("");
  const [linkOn, setLinkOn] = React.useState(true);
  const [track, setTrack] = React.useState<string | null>(null);
  const [priority, setPriority] = React.useState<number | null>(null);
  const [settings, setSettings] = React.useState(() =>
    playSettingsOf(connector),
  );
  const blocked = connectorBlocked(connector);
  const has = (c: string) => connector.controls.includes(c);
  const tone = blocked ? (connector.inert ? "warning" : "neutral") : "success";
  const state = connector.inert
    ? `Not running: ${humanize(connector.inert.reason)}`
    : connector.configured
      ? "Connected"
      : "Not configured";

  const actions: { label: string; open: () => void }[] = [];
  if (connector.kind === "asc") {
    if (has("release"))
      actions.push({
        label: "Release this version…",
        open: () =>
          setPending({
            action: "connector.releaseVersion",
            control: "release",
            title: "Release a held version on the App Store?",
            consequences: [
              "The version waiting for developer release goes live on the App Store.",
              "App Store Connect cannot take a release back.",
            ],
            confirmLabel: "Release version",
            body: {},
            done: "Released the version on the App Store",
          }),
      });
    if (has("testflight/public-link"))
      actions.push({
        label: "TestFlight public link…",
        open: () =>
          setPending({
            action: "connector.publicLink",
            control: "testflight/public-link",
            title: "Set a TestFlight group's public link",
            consequences: [
              "Anyone with the public link can join the group's beta while it is on.",
            ],
            confirmLabel: "Save public link",
            body: {},
            done: "Saved the TestFlight public link",
          }),
      });
    if (has("webhook"))
      actions.push({
        label: "Webhook setup…",
        open: () =>
          setPending({
            action: "connector.webhook",
            control: "webhook",
            title: "Register the App Store Connect webhook?",
            consequences: [
              "App Store Connect sends this product's review and release events to Polaris Key, signed with the stored webhook secret.",
              "It needs an App Store webhook secret credential (generate one with Set credential).",
            ],
            confirmLabel: "Register webhook",
            body: {},
            done: "Registered the App Store Connect webhook",
          }),
      });
  } else if (connector.kind === "play") {
    if (has("priority"))
      actions.push({
        label: "Update priority…",
        open: () =>
          setPending({
            action: "connector.priority",
            control: "priority",
            title: "Set a release's in-app update priority",
            consequences: [
              "Google Play tells the app how urgently to prompt for this release (0 none to 5 highest).",
              "The priority cannot change after a release starts rolling out.",
            ],
            confirmLabel: "Set priority",
            body: {},
            done: "Set the in-app update priority",
          }),
      });
    if (has("settings"))
      actions.push({
        label: "Settings…",
        open: () => {
          setSettings(playSettingsOf(connector));
          setPending({
            action: "connector.settings",
            control: "settings",
            title: "Google Play connector settings",
            consequences: [
              "The default in-app update priority applies when a rollout starts.",
              "The vitals auto-halt halts a staged rollout whose crash or ANR rate passes the threshold.",
            ],
            confirmLabel: "Save settings",
            body: {},
            done: "Saved the Google Play connector settings",
          });
        },
      });
  }

  const tracks = React.useMemo(() => {
    const outlets = (connector.setup?.outlets ?? []) as Array<{
      tracks?: Record<string, string>;
    }>;
    return [...new Set(outlets.flatMap((o) => Object.values(o.tracks ?? {})))];
  }, [connector.setup]);

  const releaseOptions = (releases?.releases ?? [])
    .filter((r) => r.deliverable === "app" && !r.yank)
    .map((r) => ({
      value: r.releaseId,
      label: r.version,
      secondary: r.channel ?? undefined,
    }));

  const control = pending?.control;
  const extra = (): Record<string, unknown> => {
    if (control === "release") return { releaseId };
    if (control === "testflight/public-link")
      return { betaGroupId: groupId.trim(), enabled: linkOn };
    if (control === "priority") return { track, releaseId, priority };
    if (control === "settings") return { ...settings };
    return {};
  };
  const disabled =
    control === "release"
      ? !releaseId
      : control === "testflight/public-link"
        ? groupId.trim() === ""
        : control === "priority"
          ? !track ||
            !releaseId ||
            priority === null ||
            priority < 0 ||
            priority > 5
          : false;

  return (
    <section
      aria-labelledby={`connector-${connector.kind}`}
      className="space-y-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id={`connector-${connector.kind}`}
          className="text-base font-bold text-fg-strong"
        >
          {connector.label}
        </h3>
        <StatusPill tone={tone}>{state}</StatusPill>
      </div>
      {connector.inert ? (
        <p className="text-sm text-fg-muted">{connector.inert.message}</p>
      ) : null}
      {setupFacts(connector).length ? (
        <DescriptionList columns={2} items={setupFacts(connector)} />
      ) : null}
      {connector.notes?.length ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-fg-muted">
          {connector.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {actions.length ? (
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button
              key={a.label}
              size="sm"
              variant="outline"
              disabledReason={blocked ?? undefined}
              onClick={a.open}
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : connector.kind === "ms-store" ? (
        <p className="text-xs text-fg-muted">
          The Microsoft Store connector reads submissions and availability; it
          has no controls.
        </p>
      ) : null}

      <ControlConfirm
        slug={slug}
        connector={connector.kind}
        pending={pending}
        onClose={() => setPending(null)}
        confirmDisabled={disabled}
        bodyExtra={extra}
      >
        {control === "release" || control === "priority" ? (
          <FormField<string | null>
            name="connector-release"
            label="Release"
            required
            value={releaseId}
            onChange={setReleaseId}
          >
            {(field) => (
              <Combobox
                id={field.id}
                value={releaseId}
                onChange={setReleaseId}
                aria-describedby={field["aria-describedby"]}
                placeholder="Choose a release"
                searchPlaceholder="Search versions"
                emptyText="No release matches."
                options={releaseOptions}
              />
            )}
          </FormField>
        ) : null}
        {control === "priority" ? (
          <>
            <FormField<string | null>
              name="connector-track"
              label="Track"
              required
              value={track}
              onChange={setTrack}
            >
              {(field) => (
                <Select
                  {...field}
                  ref={undefined}
                  placeholder="Choose a track"
                  options={tracks.map((t) => ({ value: t, label: t }))}
                />
              )}
            </FormField>
            <FormField<number | null>
              name="connector-priority"
              label="Priority"
              required
              help="0 (no prompt) to 5 (highest)."
              value={priority}
              onChange={setPriority}
            >
              {(field) => (
                <NumberInput
                  id={field.id}
                  value={priority}
                  onChange={setPriority}
                  integer
                  min={0}
                  max={5}
                  aria-describedby={field["aria-describedby"]}
                />
              )}
            </FormField>
          </>
        ) : null}
        {control === "testflight/public-link" ? (
          <>
            <FormField<string>
              name="connector-group"
              label="Beta group id"
              required
              help="The TestFlight group's id in App Store Connect."
              value={groupId}
              onChange={setGroupId}
            >
              {(field) => (
                <Input
                  id={field.id}
                  value={groupId}
                  mono
                  autoComplete="off"
                  onValueChange={setGroupId}
                  aria-describedby={field["aria-describedby"]}
                />
              )}
            </FormField>
            <Switch
              checked={linkOn}
              onCheckedChange={setLinkOn}
              label="Public link on"
            />
          </>
        ) : null}
        {control === "settings" ? (
          <PlaySettingsFields value={settings} onChange={setSettings} />
        ) : null}
      </ControlConfirm>
    </section>
  );
}

interface PlaySettingsDraft {
  priority: { default: number };
  vitals: {
    enabled: boolean;
    metric: string;
    windowHours: number;
    minDistinctUsers: number;
    crashRateThreshold: number;
    anrRateThreshold: number;
  };
}

function playSettingsOf(c: ConnectorStatusDto): PlaySettingsDraft {
  const v = (c.settings?.vitals ?? {}) as Partial<PlaySettingsDraft["vitals"]>;
  return {
    priority: { default: c.settings?.priority?.default ?? 0 },
    vitals: {
      enabled: v.enabled ?? false,
      metric: v.metric ?? "user-perceived",
      windowHours: v.windowHours ?? 24,
      minDistinctUsers: v.minDistinctUsers ?? 1000,
      crashRateThreshold: v.crashRateThreshold ?? 0.02,
      anrRateThreshold: v.anrRateThreshold ?? 0.01,
    },
  };
}

function PlaySettingsFields({
  value,
  onChange,
}: {
  value: PlaySettingsDraft;
  onChange: (v: PlaySettingsDraft) => void;
}): React.ReactElement {
  const vitals = (patch: Partial<PlaySettingsDraft["vitals"]>) =>
    onChange({ ...value, vitals: { ...value.vitals, ...patch } });
  return (
    <div className="space-y-3">
      <FormField<number | null>
        name="play-default-priority"
        label="Default in-app update priority"
        help="0 to 5."
        value={value.priority.default}
        onChange={(n) => onChange({ ...value, priority: { default: n ?? 0 } })}
      >
        {(field) => (
          <NumberInput
            id={field.id}
            value={value.priority.default}
            onChange={(n) =>
              onChange({ ...value, priority: { default: n ?? 0 } })
            }
            integer
            min={0}
            max={5}
            aria-describedby={field["aria-describedby"]}
          />
        )}
      </FormField>
      <Switch
        checked={value.vitals.enabled}
        onCheckedChange={(enabled) => vitals({ enabled })}
        label="Vitals auto-halt"
        description="Halts a staged rollout whose crash or ANR rate passes the threshold."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField<string | null>
          name="play-metric"
          label="Metric"
          value={value.vitals.metric}
          onChange={(m) => vitals({ metric: m ?? "user-perceived" })}
        >
          {(field) => (
            <Select
              {...field}
              ref={undefined}
              options={[
                { value: "user-perceived", label: "User-perceived" },
                { value: "all", label: "All crashes and ANRs" },
              ]}
            />
          )}
        </FormField>
        <FormField<number | null>
          name="play-window"
          label="Window"
          value={value.vitals.windowHours}
          onChange={(n) => vitals({ windowHours: n ?? 24 })}
        >
          {(field) => (
            <NumberInput
              id={field.id}
              value={value.vitals.windowHours}
              onChange={(n) => vitals({ windowHours: n ?? 24 })}
              integer
              min={1}
              max={168}
              unit="hours"
            />
          )}
        </FormField>
        <FormField<number | null>
          name="play-min-users"
          label="Minimum users"
          value={value.vitals.minDistinctUsers}
          onChange={(n) => vitals({ minDistinctUsers: n ?? 1 })}
        >
          {(field) => (
            <NumberInput
              id={field.id}
              value={value.vitals.minDistinctUsers}
              onChange={(n) => vitals({ minDistinctUsers: n ?? 1 })}
              integer
              min={1}
            />
          )}
        </FormField>
        <FormField<number | null>
          name="play-crash"
          label="Crash rate threshold"
          value={value.vitals.crashRateThreshold}
          onChange={(n) => vitals({ crashRateThreshold: n ?? 0.02 })}
        >
          {(field) => (
            <NumberInput
              id={field.id}
              value={value.vitals.crashRateThreshold}
              onChange={(n) => vitals({ crashRateThreshold: n ?? 0.02 })}
              percent
              min={0}
              max={100}
              step="any"
            />
          )}
        </FormField>
        <FormField<number | null>
          name="play-anr"
          label="ANR rate threshold"
          value={value.vitals.anrRateThreshold}
          onChange={(n) => vitals({ anrRateThreshold: n ?? 0.01 })}
        >
          {(field) => (
            <NumberInput
              id={field.id}
              value={value.vitals.anrRateThreshold}
              onChange={(n) => vitals({ anrRateThreshold: n ?? 0.01 })}
              percent
              min={0}
              max={100}
              step="any"
            />
          )}
        </FormField>
      </div>
    </div>
  );
}
