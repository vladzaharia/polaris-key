/**
 * The Namespace section of a feed's settings: the dependency-confusion rule ingest enforces, one
 * row per namespace field the ecosystem's ingest rules declare. A namespace `.pkey/release`
 * provisioned reads "From manifest" with Override until an operator changes it.
 */

import * as React from "react";
import { PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import type {
  FeedDetailDto,
  FeedEcosystem,
  FeedSettingsWrite,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { Form, FormField, useAdminForm } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SaveBar } from "../../../../ui/SaveBar.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { Textarea } from "../../../../ui/Textarea.js";
import { toast } from "../../../../ui/toast.js";
import { SettingsRow, SettingsSection } from "../../../templates/Settings.js";
import { serverFieldErrors } from "../../distribution/components/forms.js";
import { ConflictNotice, FeedSubmitError, focusSection } from "./feedForm.js";

type Save = (
  patch: Omit<FeedSettingsWrite, "expectedVersion">,
) => Promise<void>;

/** A list field as one entry per line (commas also split). */
function linesOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** How the Namespace section names one namespace field, per protocol (display copy only). */
interface NamespaceFieldCopy {
  row: string;
  label: string;
  help: string;
  placeholder: string;
}

const NAMESPACE_COPY: Record<
  FeedEcosystem,
  Record<string, NamespaceFieldCopy>
> = {
  npm: {
    scope: {
      row: "Package scope",
      label: "Scope",
      help: "Every package name must be in this scope, like @acme. Clients route only this scope here.",
      placeholder: "@acme",
    },
  },
  pypi: {
    names: {
      row: "Project names",
      label: "Names",
      help: "A published name must equal one of the names or start with one of the prefixes (PEP 503 normalized).",
      placeholder: "acme-sdk",
    },
    prefixes: {
      row: "Name prefixes",
      label: "Prefixes",
      help: "One per line.",
      placeholder: "acme",
    },
  },
  oci: {},
  swift: {
    scope: {
      row: "Package scope",
      label: "Scope",
      help: "Every package identity must be in this scope, like acme in acme.Kit.",
      placeholder: "acme",
    },
  },
  maven: {
    groupPrefixes: {
      row: "Maven groups",
      label: "Group prefixes",
      help: "Every groupId must equal or sit under one of these prefixes, like gg.acme.",
      placeholder: "gg.acme",
    },
  },
  godot: {
    publisher: {
      row: "Addon publisher",
      label: "Publisher",
      help: "The publisher every addon is listed under.",
      placeholder: "acme",
    },
  },
  cargo: {},
  go: {
    modulePrefixes: {
      row: "Module paths",
      label: "Module prefixes",
      help: "Every module path must equal or sit under one of these prefixes, like go.acme.dev. Clients name the same prefixes in GONOSUMDB.",
      placeholder: "go.acme.dev",
    },
  },
};

/** How the Namespace section names a feed whose namespace is the owner itself (no fields). */
const OWNER_NAMESPACE_COPY: Partial<
  Record<FeedEcosystem, { label: string; help: string }>
> = {
  oci: {
    label: "Repositories",
    help: "Every repository sits under the owner's path; there is nothing else to claim.",
  },
  cargo: {
    label: "Crates",
    help: "Every crate sits in the owner's own index, and Cargo takes a crate from it only for a dependency that names it with registry =. There is nothing else to claim.",
  },
};

/**
 * The namespace fields of `eco`, as its ingest rules declare them (`@polaris-key/manifest`
 * PACKAGE_ECOSYSTEM_RULES), in the copy table's order; a declared field the table lacks still
 * shows, under its own key.
 */
function namespaceFields(
  eco: FeedEcosystem,
): { key: string; kind: "string" | "list"; copy: NamespaceFieldCopy }[] {
  const fields = PACKAGE_ECOSYSTEM_RULES[eco].namespace.fields;
  const copy = NAMESPACE_COPY[eco];
  const keys = [
    ...Object.keys(copy).filter((k) => Object.hasOwn(fields, k)),
    ...Object.keys(fields).filter((k) => !Object.hasOwn(copy, k)),
  ];
  return keys.map((key) => ({
    key,
    kind: fields[key]!.kind,
    copy: copy[key] ?? { row: key, label: key, help: "", placeholder: "" },
  }));
}

type NamespaceDraft = Record<string, string>;

/** A stored namespace value as lines: one per entry, "Not set" for none. */
function valueLines(v: unknown): string[] {
  if (Array.isArray(v)) return v.length ? v.map(String) : ["Not set"];
  return [typeof v === "string" && v ? v : "Not set"];
}

export function NamespaceSection({
  eco,
  detail,
  save,
}: {
  eco: FeedEcosystem;
  detail: FeedDetailDto;
  save: Save;
}): React.ReactElement {
  const fields = namespaceFields(eco);
  const ns = detail.settings.namespace;
  const form = useAdminForm<NamespaceDraft>({
    values: Object.fromEntries(
      fields.map((f) => {
        const v = ns[f.key];
        return [
          f.key,
          f.kind === "list"
            ? Array.isArray(v)
              ? (v as string[]).join("\n")
              : ""
            : typeof v === "string"
              ? v
              : "",
        ];
      }),
    ),
    resetOn: [detail.settings.version],
    mapServerErrors: (e) => {
      const map = serverFieldErrors(e);
      if (!map?.namespace || fields.length === 0) return map;
      return { [fields[0]!.key]: map.namespace };
    },
    onSubmit: async (v) => {
      await save({
        namespace: Object.fromEntries(
          fields.map((f) => [
            f.key,
            f.kind === "list"
              ? linesOf(v[f.key] ?? "")
              : (v[f.key] ?? "").trim(),
          ]),
        ),
      });
      toast.success("Namespace saved");
      focusSection("feed-namespace");
    },
  });
  const owner = detail.owner ?? "owner";
  // The namespace `.pkey/release` provisioning wrote and no operator has changed since (the
  // server's `namespaceSource`; saving Limits or General does not touch it). It reads as it is
  // until the operator overrides it.
  const fromManifest =
    fields.length > 0 &&
    detail.settings.version > 0 &&
    detail.settings.namespaceSource === "manifest";
  const [overriding, setOverriding] = React.useState(false);
  const readOnly = fromManifest && !overriding;
  const draft = form.rhf.watch();
  // Override opens the first field; Discard (the draft going clean again) returns to the read-out.
  const wasDirty = React.useRef(false);
  React.useEffect(() => {
    if (overriding && wasDirty.current && !form.isDirty && fromManifest)
      setOverriding(false);
    wasDirty.current = form.isDirty;
  }, [overriding, form.isDirty, fromManifest]);
  React.useEffect(() => {
    if (overriding && fields[0]) form.focus(fields[0].key);
    // Only on the Override press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overriding]);
  return (
    <Form form={form} aria-label="Namespace">
      <SettingsSection
        id="feed-namespace"
        title="Namespace"
        description="The names this feed may hold. Ingest refuses anything outside it, which is the defense against dependency confusion."
        footer={
          fields.length === 0 || readOnly ? undefined : (
            <>
              <FeedSubmitError error={form.submitError} />
              <SaveBar form={form} section="Namespace" />
            </>
          )
        }
      >
        <ConflictNotice form={form} />
        {fields.length > 0 && detail.settings.version > 0 ? (
          <SettingsRow
            label="Source"
            help={
              fromManifest
                ? "Packages declared in .pkey/release outside this namespace are refused at publish."
                : undefined
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              {fromManifest ? (
                <SourceBadge
                  source="manifest"
                  path=".pkey/release"
                  explain="Written from .pkey/release when the feed was created. It is written once: a later resync does not change it."
                />
              ) : (
                <SourceBadge
                  source="admin"
                  explain="Set in the console. Provisioning from .pkey/release never overwrites it."
                />
              )}
              {readOnly ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOverriding(true)}
                >
                  Override
                </Button>
              ) : null}
              {fromManifest && overriding ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    form.discard();
                    setOverriding(false);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </SettingsRow>
        ) : null}
        {fields.length === 0 ? (
          <SettingsRow
            label={OWNER_NAMESPACE_COPY[eco]?.label ?? "Packages"}
            help={
              OWNER_NAMESPACE_COPY[eco]?.help ??
              "Every package sits under the owner's path; there is nothing else to claim."
            }
          >
            <span className="font-mono text-sm">{owner}/…</span>
          </SettingsRow>
        ) : (
          fields.map((f) =>
            readOnly ? (
              <SettingsRow key={f.key} label={f.copy.row} help={f.copy.help}>
                <ul className="space-y-0.5 text-start font-mono text-sm [overflow-wrap:anywhere]">
                  {valueLines(
                    f.kind === "list"
                      ? linesOf(draft[f.key] ?? "")
                      : (draft[f.key] ?? ""),
                  ).map((line) => (
                    <li key={line}>
                      <bdi>{line}</bdi>
                    </li>
                  ))}
                </ul>
              </SettingsRow>
            ) : f.kind === "list" ? (
              <SettingsRow
                key={f.key}
                align="stretch"
                label={f.copy.row}
                help={f.copy.help}
              >
                <FormField<string> name={f.key} label={f.copy.label} hideLabel>
                  {(field) => (
                    <Textarea
                      {...field}
                      mono
                      rows={3}
                      spellCheck={false}
                      placeholder={f.copy.placeholder}
                    />
                  )}
                </FormField>
              </SettingsRow>
            ) : (
              <SettingsRow key={f.key} label={f.copy.row} help={f.copy.help}>
                <FormField<string>
                  name={f.key}
                  label={f.copy.label}
                  hideLabel
                  className="w-full sm:w-64"
                >
                  {(field) => (
                    <Input
                      {...field}
                      mono
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={f.copy.placeholder}
                    />
                  )}
                </FormField>
              </SettingsRow>
            ),
          )
        )}
      </SettingsSection>
    </Form>
  );
}
