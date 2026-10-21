/** Hosting and quotas (HA-10): the usage rows and the product's three asset settings. */

import * as React from "react";
import type {
  AssetSettingDto,
  AssetUsageDto,
  QuotaUsageDto,
} from "../../../../api.js";
import { Callout } from "../../../../ui/Callout.js";
import { Meter } from "../../../../ui/charts/Meter.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { Switch } from "../../../../ui/Switch.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { useWriteLock } from "../../../../ui/WriteLock.js";
import { mutate } from "../../../data/mutations.js";
import { binaryBytes } from "../model/presentationSlots.js";
import { SettingsRow } from "../../../templates/Settings.js";

const QUOTA_MIB = 1024 * 1024;

/** The usage rows and the three settings (HA-10). */
export function HostingRows({
  slug,
  usage,
}: {
  slug: string;
  usage: AssetUsageDto;
}): React.ReactElement {
  const byKey = new Map(usage.settings.map((s) => [s.key, s]));
  const mirror = byKey.get("assets.releases.mirror");
  const media = byKey.get("assets.quota.mediaBytes");
  const release = byKey.get("assets.quota.releaseBytes");
  return (
    <>
      {!usage.hosting ? (
        <div className="px-5 py-4">
          <Callout
            tone="warning"
            title="Hosted assets are off on this deployment"
          >
            Every image surface shows the developer&apos;s own URLs and no new
            release file is copied (Platform → Settings → Delivery). The copies
            below stay; release files already copied keep serving from them.
          </Callout>
        </div>
      ) : null}
      <UsageRow
        label="Images"
        usage={usage.media}
        full="This product holds its whole image quota: a new or replaced image is refused, and the current copies keep serving."
      />
      {media ? <QuotaRow slug={slug} setting={media} /> : null}
      <UsageRow
        label="Release files"
        usage={usage.release}
        full="This product holds its whole release-file quota: mirroring has stopped, and GitHub keeps serving the files that have no copy."
      />
      {release ? <QuotaRow slug={slug} setting={release} /> : null}
      {mirror ? <MirrorRow slug={slug} setting={mirror} /> : null}
    </>
  );
}

function UsageRow({
  label,
  usage,
  full,
}: {
  label: string;
  usage: QuotaUsageDto;
  full: string;
}): React.ReactElement {
  return (
    <SettingsRow
      label={label}
      help={
        <>
          <span className="block">
            {binaryBytes(usage.bytes)} of {binaryBytes(usage.quota)} ·{" "}
            {usage.files} {usage.files === 1 ? "file" : "files"}
          </span>
          {usage.full ? (
            <span className="mt-2 block">
              <Callout tone="warning" title="Quota full">
                {full}
              </Callout>
            </span>
          ) : null}
        </>
      }
    >
      <Meter
        label={`${label} used`}
        hideLabel
        value={usage.bytes}
        max={usage.quota}
        format="percent"
        tone={usage.full ? "danger" : "accent"}
        className="w-40"
      />
    </SettingsRow>
  );
}

/** Where a setting's value comes from, in words. */
function settingSourceWords(s: AssetSettingDto): string {
  return s.own
    ? "Set for this product"
    : s.source === "platform"
      ? "Platform default"
      : "Default";
}

function QuotaRow({
  slug,
  setting,
}: {
  slug: string;
  setting: AssetSettingDto;
}): React.ReactElement {
  // A view-only member reads the value; Save and Reset are not offered (B-033).
  const { locked } = useWriteLock();
  const current = typeof setting.value === "number" ? setting.value : 0;
  const [mib, setMib] = React.useState<number | null>(
    Math.round(current / QUOTA_MIB),
  );
  const [confirm, setConfirm] = React.useState<"save" | "reset" | null>(null);
  React.useEffect(() => setMib(Math.round(current / QUOTA_MIB)), [current]);
  const max =
    setting.spec.kind === "integer"
      ? Math.floor(setting.spec.max / QUOTA_MIB)
      : undefined;
  const next = mib === null ? null : mib * QUOTA_MIB;
  const changed = next !== null && next !== current;
  const id = `asset-setting-${setting.key}`;
  const saveRef = React.useRef<HTMLButtonElement>(null);
  /**
   * After a save, the saved value comes back and disables Save, which may hold focus by then
   * (the dialog returns focus to it): keep focus in the row by moving it to the field. Watches
   * for a few seconds, never steals focus from anything else.
   */
  const keepFocusInRow = (): void => {
    const until = Date.now() + 5000;
    const tick = (): void => {
      const save = saveRef.current;
      const active = document.activeElement;
      const lost = !active || active === document.body || active === save;
      if (save?.disabled && lost) {
        document.getElementById(id)?.focus({ preventScroll: true });
        return;
      }
      if (Date.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const inherited =
    typeof setting.inherited === "number" ? setting.inherited : null;
  return (
    <SettingsRow
      label={setting.label}
      htmlFor={id}
      help={
        <>
          <span className="block">{setting.description}</span>
          <span className="block">
            {settingSourceWords(setting)}: {binaryBytes(current)}
          </span>
        </>
      }
    >
      <span className="flex flex-wrap items-center justify-end gap-2">
        <NumberInput
          id={id}
          className="w-32"
          value={mib}
          onChange={setMib}
          integer
          min={0}
          max={max}
          unit="MiB"
          aria-label={`${setting.label} in MiB`}
        />
        {locked ? null : (
          <Button
            ref={saveRef}
            size="sm"
            // Two quota rows share this section: a row's save is secondary, so the section has
            // no more than one primary button.
            variant="secondary"
            disabled={!changed}
            onClick={() => setConfirm("save")}
          >
            Save
          </Button>
        )}
        {setting.own && !locked ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirm("reset")}>
            Reset
          </Button>
        ) : null}
      </span>
      <ConfirmDialog
        open={confirm === "save"}
        onOpenChange={(o) => setConfirm(o ? "save" : null)}
        intent="caution"
        title={`Set the ${setting.label.toLowerCase()} to ${next === null ? "" : binaryBytes(next)}?`}
        consequences={[
          next !== null && next < current
            ? "A file that would take the product past it is refused; the copies it already holds keep serving."
            : "More of this product's files can be copied and served.",
          "Only this product changes; the platform default stays.",
        ]}
        confirmLabel="Save"
        onConfirm={async () => {
          if (next === null) return;
          await mutate("saveAssetSetting", slug, setting.key, {
            value: next,
            expectedVersion: setting.version,
          });
          keepFocusInRow();
          toast.success(`${setting.label} set to ${binaryBytes(next)}`);
        }}
      />
      <ConfirmDialog
        open={confirm === "reset"}
        onOpenChange={(o) => setConfirm(o ? "reset" : null)}
        intent="caution"
        title={`Reset the ${setting.label.toLowerCase()}?`}
        consequences={[
          inherited === null
            ? "The product follows the platform default again."
            : `The product follows the platform default again: ${binaryBytes(inherited)}.`,
        ]}
        confirmLabel="Reset"
        onConfirm={async () => {
          await mutate("resetAssetSetting", slug, setting.key, setting.version);
          toast.success(`${setting.label} follows the platform default`);
        }}
      />
    </SettingsRow>
  );
}

function MirrorRow({
  slug,
  setting,
}: {
  slug: string;
  setting: AssetSettingDto;
}): React.ReactElement {
  const on = setting.value === "on";
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const save = async (value: "on" | "off"): Promise<void> => {
    await mutate("saveAssetSetting", slug, setting.key, {
      value,
      expectedVersion: setting.version,
    });
    toast.success(
      value === "on"
        ? "Release files are mirrored again"
        : "No new release file is copied; copies already made keep serving",
    );
  };
  const id = `asset-setting-${setting.key}`;
  return (
    <SettingsRow
      label={setting.label}
      htmlFor={id}
      help={
        <>
          <span className="block">{setting.description}</span>
          <span className="block">{settingSourceWords(setting)}</span>
        </>
      }
    >
      <Switch
        id={id}
        checked={on}
        disabled={busy}
        onCheckedChange={(c) => {
          if (!c) {
            setConfirmOff(true);
            return;
          }
          setBusy(true);
          save("on")
            .catch((e: unknown) => toast.error(e))
            .finally(() => setBusy(false));
        }}
      />
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        intent="caution"
        title="Stop mirroring this product's release files?"
        consequences={[
          "No new release file is copied; GitHub serves them.",
          "Copies already made stay valid and keep serving.",
        ]}
        confirmLabel="Stop mirroring"
        onConfirm={() => save("off")}
      />
    </SettingsRow>
  );
}
