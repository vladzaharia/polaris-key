import * as React from "react";
import { ChannelPicker } from "../../ui/ChannelPicker.js";
import { Checkbox } from "../../ui/Checkbox.js";
import { CodeEditor, CodeEditorFallback } from "../../ui/CodeEditor.js";
import { Combobox } from "../../ui/Combobox.js";
import { DateInput } from "../../ui/DateInput.js";
import {
  Form,
  FormField,
  useAdminForm,
  type FieldControlProps,
} from "../../ui/form.js";
import { Input } from "../../ui/Input.js";
import { NumberInput, numberRangeError } from "../../ui/NumberInput.js";
import { OrderedMultiSelect } from "../../ui/OrderedMultiSelect.js";
import { RadioCards } from "../../ui/RadioCards.js";
import { SaveBar } from "../../ui/SaveBar.js";
import { SecretInput } from "../../ui/SecretInput.js";
import { SegmentedControl } from "../../ui/SegmentedControl.js";
import { Select } from "../../ui/Select.js";
import { Switch } from "../../ui/Switch.js";
import { Textarea } from "../../ui/Textarea.js";
import { VersionInput, versionError } from "../../ui/VersionInput.js";
import type { Story } from "../types.js";

// Fixed instants so the gallery and the axe suite render the same text every time.
const SEP_30_2026 = Date.UTC(2026, 8, 30, 21, 59, 59);

const RELEASES = [
  { value: "rel_240", label: "2.4.0", secondary: "stable · 3 Oct 2026" },
  { value: "rel_240rc2", label: "2.4.0-rc.2", secondary: "beta · 1 Oct 2026" },
  { value: "rel_239", label: "2.3.9", secondary: "stable · 24 Sep 2026" },
];

const PROFILES = [
  { value: "base-pro", label: "base-pro", secondary: "12 keys" },
  { value: "studio-overrides", label: "studio-overrides", secondary: "3 keys" },
  { value: "edu", label: "edu", secondary: "5 keys" },
];

const ACCESS = [
  {
    value: "public",
    label: "Public",
    description: "Anyone with the feed URL can download.",
  },
  {
    value: "authenticated",
    label: "Authenticated",
    description: "Any signed-in device; no license needed.",
  },
  {
    value: "licensed",
    label: "Licensed",
    description: "Devices with an active license.",
  },
  {
    value: "entitled",
    label: "Entitled",
    description: "Licenses that carry the chosen flag.",
  },
] as const;

/** A standalone field: the controlled FormField outside a Form. */
function Field<V>({
  label,
  help,
  required,
  error,
  dirty,
  group,
  initial,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  error?: string;
  dirty?: boolean;
  group?: boolean;
  initial: V;
  children: (field: FieldControlProps<V>) => React.ReactNode;
}): React.ReactElement {
  const [value, setValue] = React.useState<V>(initial);
  return (
    <FormField<V>
      name={label}
      label={label}
      help={help}
      required={required}
      error={error}
      dirty={dirty}
      group={group}
      value={value}
      onChange={setValue}
    >
      {children}
    </FormField>
  );
}

interface Terms extends Record<string, unknown> {
  name: string;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string;
  profiles: string[];
}

const TERMS: Terms = {
  name: "Studio Pro",
  maxOfflineDays: 30,
  channels: ["stable", "beta"],
  minVersion: "2.0.0",
  profiles: ["base-pro"],
};

function TermsForm(): React.ReactElement {
  const form = useAdminForm<Terms>({
    values: TERMS,
    onSubmit: async () => {
      await new Promise((r) => setTimeout(r, 600));
    },
    validate: (v) => {
      const out: Record<string, string> = {};
      if (!v.name.trim()) out.name = "Enter a holder name.";
      const range = numberRangeError(v.maxOfflineDays, { min: 0, max: 365 });
      if (range) out.maxOfflineDays = range;
      const version = versionError(v.minVersion);
      if (version) out.minVersion = version;
      return out;
    },
  });
  return (
    <Form form={form} aria-label="License terms" className="max-w-xl space-y-4">
      <FormField name="name" label="Holder" required>
        {(f) => <Input {...f} />}
      </FormField>
      <FormField
        name="maxOfflineDays"
        label="Max offline days"
        help="Blank uses the tier or product default (30)."
      >
        {(f) => <NumberInput {...f} nullable unit="days" integer />}
      </FormField>
      <FormField name="channels" label="Channels" group>
        {(f) => <ChannelPicker {...f} />}
      </FormField>
      <FormField name="minVersion" label="Minimum version">
        {(f) => <VersionInput {...f} />}
      </FormField>
      <FormField name="profiles" label="Profiles" group>
        {(f) => (
          <OrderedMultiSelect
            {...f}
            options={PROFILES}
            addLabel="Add profile"
            orderHint="Later profiles override earlier ones."
          />
        )}
      </FormField>
      <SaveBar form={form} saveLabel="Save terms" />
    </Form>
  );
}

interface General extends Record<string, unknown> {
  name: string;
  adminGroup: string;
}
interface Defaults extends Record<string, unknown> {
  maxOffline: number | null;
  deviceLimit: number | null;
}
const GENERAL: General = { name: "DJDL", adminGroup: "djdl-admins" };
const DEFAULTS: Defaults = { maxOffline: 30, deviceLimit: 5 };

function SettingsScopes(): React.ReactElement {
  const general = useAdminForm<General>({
    values: GENERAL,
    onSubmit: () => undefined,
  });
  const defaults = useAdminForm<Defaults>({
    values: DEFAULTS,
    onSubmit: () => undefined,
  });
  return (
    <div className="space-y-4">
      <section
        aria-labelledby="kit-general"
        className="rounded-lg border border-border p-4"
      >
        <h4
          id="kit-general"
          className="mb-3 text-sm font-semibold text-fg-strong"
        >
          General
        </h4>
        <Form form={general} aria-label="General" className="space-y-3">
          <FormField name="name" label="Display name" required>
            {(f) => <Input {...f} />}
          </FormField>
          <FormField
            name="adminGroup"
            label="Admin group"
            help="Metadata only. It grants nothing: console access is platform-wide."
          >
            {(f) => <Input {...f} mono clearable />}
          </FormField>
          <SaveBar form={general} section="General" />
        </Form>
      </section>
      <section
        aria-labelledby="kit-defaults"
        className="rounded-lg border border-border p-4"
      >
        <h4
          id="kit-defaults"
          className="mb-3 text-sm font-semibold text-fg-strong"
        >
          License defaults
        </h4>
        <Form
          form={defaults}
          aria-label="License defaults"
          className="space-y-3"
        >
          <FormField name="maxOffline" label="Default max offline days">
            {(f) => <NumberInput {...f} nullable unit="days" integer />}
          </FormField>
          <FormField name="deviceLimit" label="Default device limit">
            {(f) => <NumberInput {...f} nullable integer />}
          </FormField>
          <SaveBar form={defaults} section="License defaults" />
        </Form>
      </section>
    </div>
  );
}

const RATE = { rate: 0.05 as number | null };

/** A dirty form, so the SaveBar shows in the gallery without typing. */
function DirtySaveBar(): React.ReactElement {
  const form = useAdminForm<{ rate: number | null }>({
    values: RATE,
    onSubmit: () => {
      throw new Error("refused");
    },
    mapServerErrors: () => ({ rate: "Use a rate between 0 % and 50 %." }),
  });
  const { setValue } = form.rhf;
  React.useEffect(() => {
    setValue("rate", 0.6, { shouldDirty: true });
  }, [setValue]);
  return (
    <Form form={form} aria-label="Auto-halt" className="space-y-3">
      <FormField
        name="rate"
        label="Revert rate threshold"
        help="Halts the rollout above this rate."
      >
        {(f) => <NumberInput {...f} percent nullable />}
      </FormField>
      <SaveBar form={form} section="Auto-halt" onReview={() => undefined} />
    </Form>
  );
}

const inJsdom =
  typeof navigator !== "undefined" && navigator.userAgent.includes("jsdom");

function validateJson(t: string) {
  try {
    JSON.parse(t);
    return [];
  } catch (e) {
    return [{ line: 1, column: 1, message: (e as Error).message }];
  }
}

function LiveCodeEditor(): React.ReactElement {
  const [text, setText] = React.useState('{"schemaVersion": 1, "entries": []}');
  // jsdom lays nothing out for CodeMirror: the axe suite checks the loading state, every time.
  if (inJsdom)
    return (
      <CodeEditorFallback
        value={text}
        aria-label="Catalog JSON"
        heightClass="h-40"
      />
    );
  return (
    <CodeEditor
      value={text}
      onChange={setText}
      language="json"
      formattable
      validate={validateJson}
      heightClass="h-40"
      aria-label="Catalog JSON"
    />
  );
}

export const stories: Story[] = [
  {
    id: "form-text-inputs",
    group: "Forms",
    title: "Input and Textarea",
    description:
      "Prefix, suffix, clearable, mono; required, help, error, dirty, disabled, read-only.",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" required initial="DJDL">
          {(f) => <Input {...f} />}
        </Field>
        <Field
          label="Feed host"
          help="Where devices fetch updates."
          initial="dl.plrs.im"
        >
          {(f) => <Input {...f} prefix="https://" clearable />}
        </Field>
        <Field
          label="Product slug"
          error="That slug is already in use."
          initial="djdl"
        >
          {(f) => <Input {...f} mono />}
        </Field>
        <Field label="Admin group" dirty initial="djdl-admins">
          {(f) => <Input {...f} mono clearable />}
        </Field>
        <Field label="Signing kid" initial="pk-2026-03">
          {(f) => <Input {...f} mono readOnly />}
        </Field>
        <Field label="Disabled" initial="Unavailable">
          {(f) => <Input {...f} disabled />}
        </Field>
        <Field
          label="Description"
          help="Grows with its content."
          initial="Pro seats for the studio."
        >
          {(f) => <Textarea {...f} />}
        </Field>
        <Field label="Payload (mono)" initial={'{\n  "theme": "dark"\n}'}>
          {(f) => <Textarea {...f} mono />}
        </Field>
      </div>
    ),
  },
  {
    id: "form-number-inputs",
    group: "Forms",
    title: "NumberInput",
    description:
      "Empty is null, never 0. Percent stores a fraction and shows %.",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-3">
        <Field<number | null>
          label="Max offline days"
          help="Blank uses the default (30)."
          initial={null}
        >
          {(f) => <NumberInput {...f} nullable clearable unit="days" integer />}
        </Field>
        <Field<number | null> label="Revert rate" initial={0.125}>
          {(f) => <NumberInput {...f} percent />}
        </Field>
        <Field<number | null>
          label="Device limit"
          error="Use 1 or more."
          initial={0}
        >
          {(f) => <NumberInput {...f} integer />}
        </Field>
      </div>
    ),
  },
  {
    id: "form-select",
    group: "Forms",
    title: "Select",
    description:
      "Labelled through the trigger's id; allowEmpty means null; option descriptions.",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-3">
        <Field<string | null> label="Usage" required initial="general">
          {(f) => (
            <Select
              {...f}
              options={[
                {
                  value: "general",
                  label: "General",
                  description: "Read by your own code.",
                },
                {
                  value: "edge-mint",
                  label: "Edge mint",
                  description: "Signs edge-minted licenses.",
                },
              ]}
            />
          )}
        </Field>
        <Field<string | null>
          label="Profile"
          help="None uses the tier's."
          initial={null}
        >
          {(f) => <Select {...f} allowEmpty options={PROFILES} />}
        </Field>
        <Field<string | null>
          label="Kind"
          error="Choose a kind."
          initial={null}
        >
          {(f) => (
            <Select {...f} options={[{ value: "config", label: "Config" }]} />
          )}
        </Field>
      </div>
    ),
  },
  {
    id: "form-combobox",
    group: "Forms",
    title: "Combobox and OrderedMultiSelect",
    description:
      "Searchable release picker (version, channel, date); profiles where order is precedence.",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-2">
        <Field<string | null> label="Release" initial="rel_240">
          {(f) => (
            <Combobox
              {...f}
              options={RELEASES}
              clearable
              searchPlaceholder="Search releases"
            />
          )}
        </Field>
        <Field<string[]> label="Outlets" initial={["direct"]}>
          {(f) => (
            <Combobox
              {...f}
              multiple
              options={[
                { value: "direct", label: "direct" },
                { value: "appstore", label: "App Store" },
                { value: "play", label: "Google Play" },
              ]}
            />
          )}
        </Field>
        <Field<string[]>
          label="Profiles"
          group
          initial={["base-pro", "studio-overrides"]}
        >
          {(f) => (
            <OrderedMultiSelect
              {...f}
              options={PROFILES}
              addLabel="Add profile"
              orderHint="Later profiles override earlier ones."
            />
          )}
        </Field>
        <Field<string[]> label="Profiles (empty)" group initial={[]}>
          {(f) => (
            <OrderedMultiSelect
              {...f}
              options={PROFILES}
              addLabel="Add profile"
            />
          )}
        </Field>
      </div>
    ),
  },
  {
    id: "form-choices",
    group: "Forms",
    title: "Checkbox, Switch, RadioCards, SegmentedControl, ChannelPicker",
    render: () => (
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-3">
          <Checkbox
            label="Include config"
            description="Bundles the license's effective config."
            checked
          />
          <Checkbox label="Partly selected" checked="indeterminate" />
          <Checkbox label="Disabled" disabled />
          <Switch
            label="Portal on"
            description="Customers can sign in at your portal."
            checked
          />
          <Switch label="Email link sign-in" />
        </div>
        <div className="space-y-4">
          <Field<string> label="Window" group initial="24">
            {(f) => (
              <SegmentedControl
                {...f}
                options={[
                  { value: "1", label: "1 h" },
                  { value: "6", label: "6 h" },
                  { value: "24", label: "24 h" },
                  { value: "72", label: "72 h" },
                ]}
              />
            )}
          </Field>
          <Field<string[]> label="Channels" group initial={["stable", "beta"]}>
            {(f) => <ChannelPicker {...f} manual={["nightly"]} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field<string>
            label="Access"
            group
            help="Who can download this deliverable."
            initial="licensed"
          >
            {(f) => <RadioCards {...f} options={ACCESS} columns={4} />}
          </Field>
        </div>
      </div>
    ),
  },
  {
    id: "form-date-version-secret",
    group: "Forms",
    title: "DateInput, VersionInput, SecretInput",
    description:
      "Dates are the operator's local day, shown with the zone. Secrets are write-only.",
    render: () => (
      <div className="grid gap-4 sm:grid-cols-3">
        <Field<number | null> label="Expires" initial={SEP_30_2026}>
          {(f) => (
            <DateInput
              {...f}
              resolvedLabel="Expires"
              timeZone="Europe/Berlin"
              locale="en-GB"
            />
          )}
        </Field>
        <Field<string>
          label="Maximum version"
          error="Use a version such as 2.0.0."
          initial="2.x"
        >
          {(f) => <VersionInput {...f} />}
        </Field>
        <Field<string> label="OIDC client secret" initial="">
          {(f) => <SecretInput {...f} configured />}
        </Field>
      </div>
    ),
  },
  {
    id: "form-code-editor",
    group: "Forms",
    title: "CodeEditor (lazy)",
    description:
      "CodeMirror loads on first use; the textarea is its loading state.",
    render: () => <LiveCodeEditor />,
  },
  {
    id: "form-full",
    group: "Forms",
    title: "Form with SaveBar",
    description:
      "Edit any field: the SaveBar appears, ⌘S saves, Esc from the bar asks before discarding.",
    render: () => <TermsForm />,
  },
  {
    id: "form-savebar-error",
    group: "Forms",
    title: "SaveBar: dirty, with a server error",
    description:
      "Press Save: the error lands on the field, focus moves to it, the bar links to it.",
    render: () => <DirtySaveBar />,
  },
  {
    id: "form-t4-scopes",
    group: "Forms",
    title: "Two save scopes (T4)",
    description:
      "One form per independently saved resource; each bar names its section.",
    render: () => <SettingsScopes />,
  },
];
