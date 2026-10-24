import * as React from "react";
import { MonitorSmartphone } from "lucide-react";
import type {
  LicenseChoice,
  LicenseChoiceView,
} from "@polaris-key/protocol/identity";
import { Button } from "../../../ui/Button.js";
import { AuthTitle, QuietLink, QuietLinks } from "../../../ui/auth/index.js";
import { t } from "../../../lib/copy.js";
import {
  classifyChoice,
  rowModel,
  waitText,
  type RowModel,
} from "../../model/signInRequest.js";
import {
  ChoiceGroup,
  InkMeter,
  NeutralCallout,
  PersonRow,
  Pill,
  PRIMARY_CLASS,
  type ChoiceOption,
} from "./requestParts.js";

/**
 * LicenseChoiceStep (SIGN-IN.md §3.6, PX-14a): "Choose a license for this device". One radio
 * group of the licences, the server's order and preselection (a Create row is never preselected,
 * and with every row full nothing is, unless one row is all there is); a full row says **No free
 * devices** in text and, among free rows, carries its own **Replace a device**. One ink primary:
 * **Use this license**, or **Replace a device** while a full row is chosen. A
 * primary pressed with nothing chosen is not disabled: the error sits under the group.
 */
export function LicenseChoiceStep({
  view,
  product,
  developer,
  deviceName,
  browser,
  keyHref,
  initialId = null,
  person,
  onNotYou,
  onUse,
  onReplace,
  onCancel,
  notice,
}: {
  view: LicenseChoiceView;
  product: string;
  developer: string;
  deviceName: string;
  /** No device label: the lede says "in this browser". */
  browser: boolean;
  /** Where "Use a license key instead" goes (the Activate page, which returns here), or null. */
  keyHref: string | null;
  /** The row the person picked before (Change and Escape from consent keep it). */
  initialId?: string | null;
  person: { name: string | null; email: string | null; picture: string | null };
  onNotYou: () => void;
  onUse: (
    pick: { kind: "license"; row: LicenseChoice } | { kind: "create" },
  ) => void;
  onReplace: (row: LicenseChoice) => void;
  onCancel: () => void;
  /** A race or a gone seat, said above the list. */
  notice?: string | null;
}): React.ReactElement {
  const state = classifyChoice(view);
  const rows = view.choices.map((r) =>
    rowModel(r, view.choices, { product, developer }),
  );
  const allFull =
    state === "all-full" ||
    (state === "create" && rows.every((r) => !r.selectable));
  const fullRows = rows.filter((r) => !r.selectable && r.tag === "full");
  const [value, setValue] = React.useState<string>(() => {
    if (
      initialId &&
      (initialId === "create"
        ? view.create
        : view.choices.some((c) => c.id === initialId))
    )
      return initialId;
    // Create is the only row that can act: choose it.
    if (view.create && rows.every((r) => !r.selectable && !r.canReplace))
      return "create";
    if (view.preselected && view.preselected !== "keep")
      return view.preselected;
    // Every row full and one row: nothing else to pick, so nothing to leave unchosen.
    if (view.state === "choose" && view.choices.length === 1 && !view.create)
      return view.choices[0]!.id;
    return "";
  });
  const [error, setError] = React.useState<string | null>(null);
  const group = React.useRef<HTMLDivElement>(null);

  // A refreshed list may no longer hold the chosen row.
  React.useEffect(() => {
    if (
      value &&
      value !== "create" &&
      !view.choices.some((c) => c.id === value)
    )
      setValue("");
  }, [view, value]);

  const chosenRow = view.choices.find((c) => c.id === value) ?? null;
  const chosenFull = chosenRow?.state === "full";
  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (value === "create" && view.create) return onUse({ kind: "create" });
    if (!chosenRow) {
      setError(t("signin.choice.pickOne"));
      group.current?.querySelector<HTMLElement>("[role=radio]")?.focus();
      return;
    }
    if (chosenRow.state === "full") return onReplace(chosenRow);
    if (chosenRow.state === "free")
      return onUse({ kind: "license", row: chosenRow });
    setError(t("signin.choice.pickOne"));
  };

  const options: ChoiceOption[] = [];
  const asOption = (m: RowModel): ChoiceOption => ({
    value: m.id,
    label: [
      m.title,
      m.pill,
      m.tag === "full" ? t("signin.choice.tag.full") : null,
      m.devices,
      m.meta,
    ]
      .filter(Boolean)
      .join(", "),
    children: <RowBody m={m} />,
  });
  for (const m of rows)
    if (m.selectable || (allFull && m.canReplace)) options.push(asOption(m));
  if (view.create)
    options.push({
      value: "create",
      label: `${t("signin.choice.create")}, ${t("signin.choice.tag.new")}`,
      children: (
        <>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg-strong">
              {t("signin.choice.create")}
            </span>
            <Pill>{t("signin.choice.tag.new")}</Pill>
          </span>
          <span className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Pill>{view.create.tierName}</Pill>
            <span>{t("signin.choice.devices", { used: 1, limit: 1 })}</span>
          </span>
          <span className="block text-sm text-fg-muted">
            {t("signin.choice.createMeta")}
          </span>
        </>
      ),
    });
  const stand = fullRows.filter((m) => !(allFull && m.canReplace));
  const replaceable = fullRows.some((r) => r.canReplace);
  const wait = fullRows.find((r) => r.retryAfter !== null)?.retryAfter ?? null;
  // Nothing here can act: no free row, no replaceable row, no Create. No primary then.
  const noAction = allFull && !replaceable && !view.create;

  const primary =
    ((allFull && replaceable) || chosenFull) && value !== "create"
      ? t("signin.replace.open")
      : t("signin.choice.continue");
  return (
    <form noValidate onSubmit={submit} className="space-y-5">
      <PersonRow {...person} onNotYou={onNotYou} />
      <div className="space-y-2">
        <AuthTitle>{t("signin.choice.title")}</AuthTitle>
        <p className="text-fg-muted">
          {browser
            ? t("signin.choice.ledeBrowser", { product })
            : t("signin.choice.lede", { product, device: deviceName })}
        </p>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-fg">
          {notice}
        </p>
      ) : null}
      <ChoiceGroup
        ref={group}
        id="pk-choice"
        label={t("signin.choice.group", { product })}
        value={value}
        onChange={(v) => {
          setValue(v);
          setError(null);
        }}
        options={options}
        error={error}
      />
      {stand.length > 0 ? (
        <ul className="space-y-2">
          {stand.map((m) => (
            <li
              key={m.id}
              className="space-y-2 rounded-md border border-border bg-surface-sunken px-3 py-3"
            >
              <RowBody m={m} />
              {m.canReplace ? (
                <Button
                  variant="outline"
                  className="min-h-11 w-full"
                  onClick={() => {
                    const row = view.choices.find((c) => c.id === m.id);
                    if (row) onReplace(row);
                  }}
                >
                  {t("signin.replace.open")}
                </Button>
              ) : m.freeDeviceUrl ? (
                <a
                  href={m.freeDeviceUrl}
                  className="inline-flex min-h-11 items-center text-sm underline decoration-2 underline-offset-4"
                >
                  {t("signin.choice.freeDevice")}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {allFull ? (
        <NeutralCallout icon={<MonitorSmartphone />}>
          <p>
            {wait !== null && !replaceable
              ? waitText(wait)
              : view.create
                ? t("signin.choice.allFullCreate")
                : replaceable
                  ? t("signin.choice.allFull")
                  : t("signin.choice.noneReplaceable", { developer })}
          </p>
        </NeutralCallout>
      ) : null}
      {noAction ? null : (
        <Button
          type="submit"
          variant="neutral"
          size="lg"
          className={PRIMARY_CLASS}
        >
          {primary}
        </Button>
      )}
      <QuietLinks>
        {keyHref ? (
          <a
            href={keyHref}
            className="inline-flex min-h-11 items-center rounded-sm px-1 underline decoration-2 underline-offset-4 hover:text-fg-strong"
          >
            {t("signin.choice.keyInstead")}
          </a>
        ) : null}
        <QuietLink onClick={onCancel}>{t("signin.cancel")}</QuietLink>
      </QuietLinks>
    </form>
  );
}

/** A licence row's three lines: the title and its tag, the tier and devices, the meta and meter. */
function RowBody({ m }: { m: RowModel }): React.ReactElement {
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg-strong [overflow-wrap:anywhere]">
          {m.title}
        </span>
        {m.tag === "current" ? (
          <Pill>{t("signin.choice.tag.current")}</Pill>
        ) : null}
        {m.tag === "full" ? <Pill>{t("signin.choice.tag.full")}</Pill> : null}
      </span>
      <span className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <Pill>{m.pill}</Pill>
        {m.devices ? <span>{m.devices}</span> : null}
      </span>
      <span className="block text-sm text-fg-muted">{m.meta}</span>
      {m.meter ? (
        <InkMeter
          used={m.meter.used}
          limit={m.meter.limit}
          label={m.devices ?? ""}
        />
      ) : null}
    </>
  );
}
