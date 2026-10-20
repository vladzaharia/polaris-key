import * as React from "react";
import { AlertTriangle, Laptop, Monitor, Smartphone } from "lucide-react";
import type { LicenseChoice } from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import { Spinner } from "../../../ui/Spinner.js";
import { AuthTitle, QuietLink, QuietLinks } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import { portalErrorCopy } from "../../errors.js";
import {
  deviceRows,
  rowModel,
  type DeviceRowModel,
} from "../../model/signInRequest.js";
import { useSignInDevices } from "../../requestData.js";
import {
  ChoiceGroup,
  NeutralCallout,
  Pill,
  PRIMARY_CLASS,
  type ChoiceOption,
} from "./requestParts.js";

/**
 * ReplaceDevice (SIGN-IN.md §3.7, PX-14a; the Worker's M12 decision): the full licence's seat
 * holders as a radio group with nothing preselected, the safety line naming what happens, and
 * one ink primary, **Replace and sign in**. Pressed with nothing chosen it is not disabled: the
 * error sits under the group. Nothing is written here; the choice goes on to the consent step,
 * which applies it with Continue.
 */
export function ReplaceDeviceStep({
  handle,
  row,
  rows,
  app,
  product,
  developer,
  thisDevice,
  onConfirm,
  onBack,
}: {
  handle: string;
  row: LicenseChoice;
  rows: readonly LicenseChoice[];
  app: string;
  product: string;
  developer: string;
  thisDevice: string;
  onConfirm: (device: DeviceRowModel) => void;
  onBack: () => void;
}): React.ReactElement {
  const q = useSignInDevices(handle, row.id);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const group = React.useRef<HTMLDivElement>(null);
  const m = rowModel(row, rows, { product, developer });
  const devices = q.data ? deviceRows(q.data) : [];

  if (q.isPending)
    return (
      <div className="space-y-4" aria-busy="true">
        <AuthTitle>{t("signin.replace.heading")}</AuthTitle>
        <Spinner />
      </div>
    );
  if (q.error || !q.data) {
    const copy = portalErrorCopy(q.error, { account: true });
    return (
      <>
        <div className="space-y-2">
          <AuthTitle>{t("signin.replace.heading")}</AuthTitle>
          <p className="text-fg-muted">{copy.description}</p>
        </div>
        <Button
          variant="neutral"
          size="lg"
          className={PRIMARY_CLASS}
          onClick={() => void q.refetch()}
        >
          {t("signin.retry")}
        </Button>
        <QuietLinks>
          <QuietLink onClick={onBack}>{t("signin.replace.back")}</QuietLink>
        </QuietLinks>
      </>
    );
  }

  const blocked = !q.data.replace.allowed;
  const picked = devices.find((d) => d.id === value) ?? null;
  const options: ChoiceOption[] = devices.map((d) => ({
    value: d.id,
    label: [d.label, d.meta].join(", "),
    children: (
      <>
        <span className="flex flex-wrap items-center gap-2">
          <DeviceGlyph label={d.label} />
          <span className="font-medium text-fg-strong [overflow-wrap:anywhere]">
            {d.label}
          </span>
          {d.leastRecent ? (
            <Pill>{t("signin.replace.leastRecent")}</Pill>
          ) : null}
          {d.activeNow ? <Pill>{t("signin.replace.activeNow")}</Pill> : null}
          {d.thisBrowser ? (
            <Pill>{t("signin.replace.thisBrowser")}</Pill>
          ) : null}
        </span>
        <span className="block text-sm text-fg-muted">{d.meta}</span>
      </>
    ),
  }));

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (blocked) return;
    if (!picked) {
      setError(t("signin.choice.pickDevice"));
      group.current?.querySelector<HTMLElement>("[role=radio]")?.focus();
      return;
    }
    onConfirm(picked);
  };

  return (
    <form noValidate onSubmit={submit} className="space-y-5">
      <div className="space-y-2">
        <AuthTitle>{t("signin.replace.heading")}</AuthTitle>
        <p className="flex flex-wrap items-center gap-2 text-fg-muted">
          <span className="font-medium text-fg-strong">{m.title}</span>
          <Pill>{m.pill}</Pill>
          {m.devices ? <span className="text-sm">{m.devices}</span> : null}
        </p>
        <p className="text-fg-muted">
          {t("signin.replace.lede", { thisDevice })}
        </p>
      </div>
      {blocked ? (
        <NeutralCallout icon={<Monitor />}>
          <p>
            {q.data.replace.retryAfter !== null
              ? t("signin.replace.rateLimited", {
                  seconds: q.data.replace.retryAfter,
                })
              : t("signin.choice.noneReplaceable", { developer })}
          </p>
        </NeutralCallout>
      ) : (
        <>
          <ChoiceGroup
            ref={group}
            id="pk-replace"
            label={t("signin.replace.heading")}
            value={value}
            onChange={(v) => {
              setValue(v);
              setError(null);
            }}
            options={options}
            error={error}
          />
          {picked?.activeNow ? (
            <p className="flex items-start gap-2 text-sm text-fg-strong">
              <AlertTriangle
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-warning"
              />
              {t("signin.replace.inUse", { device: picked.label })}
            </p>
          ) : null}
          <p className="text-sm text-fg-muted">
            {t("signin.choice.replaceSafety", { app })}
          </p>
          <Button
            type="submit"
            variant="neutral"
            size="lg"
            className={PRIMARY_CLASS}
          >
            {t("signin.choice.replaceAndSignIn")}
          </Button>
        </>
      )}
      <QuietLinks>
        <QuietLink onClick={onBack}>{t("signin.replace.back")}</QuietLink>
      </QuietLinks>
    </form>
  );
}

function DeviceGlyph({ label }: { label: string }): React.ReactElement {
  const phone = /phone|pixel|ipad|tablet|galaxy/i.test(label);
  const Glyph = phone
    ? Smartphone
    : /mac|book|laptop/i.test(label)
      ? Laptop
      : Monitor;
  return <Glyph aria-hidden className="size-4 shrink-0 text-fg-muted" />;
}
