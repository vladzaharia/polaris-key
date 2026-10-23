/**
 * Keys and secrets → Secrets (docs/design/ADMIN.md §6.7). Write-only product secrets: an OIDC client
 * secret, edge-mint key material. Values are sealed under the platform key and never returned.
 *
 * - Rows are the union of what is stored and what the configuration requires (A-5), each with
 *   its usage, status, last update and what requires it (SEC-2).
 * - Set secret is a drawer: name, value and usage. Replacing a configured value needs "Replace the
 *   existing value" ticked (SEC-3). A required row's "Set…" preselects its name (SEC-4), and so
 *   does a link with `?secret=<name>` (FLOWS.md C-7). One phrasing: "Never shown again."
 * - The usage choices live in `lib/secretUsage.ts`, not in a view (SEC-6).
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, type ProductSecretDto } from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { fromSeconds } from "../../../../lib/format.js";
import {
  USAGE_CHOICES,
  type UsageChoice,
} from "../../../../lib/secretUsage.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { CopyDetails } from "../../../../ui/CopyDetails.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../../ui/Drawer.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { Select } from "../../../../ui/Select.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { reads } from "../../../data/reads.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { codecs } from "../../../routes.js";
import { useSearchParam } from "../../../router.js";
import { qk } from "../../../data/queries.js";
import { SettingsSection } from "../../../templates/Settings.js";

const SECRET_PARAM = codecs.string();

const USAGE_TEXT: Record<string, string> = {
  general: "General",
  "edge-mint": "Edge-mint signing key",
};

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What needs the secret, minus an entry that is only the secret's own name ("OIDC client secret"). */
export function neededBy(
  name: string,
  requiredBy: readonly string[],
): string[] {
  return requiredBy.filter((r) => squash(r) !== squash(name));
}

export function SecretsSection({ slug }: { slug: string }): React.ReactElement {
  const secrets = useQuery(reads.secrets(slug));
  const [editing, setEditing] = React.useState<{ name: string } | null>(null);
  // `?secret=<name>` opens Set secret with the name filled in; closing it drops the parameter.
  const [linked, setLinked] = useSearchParam("secret", SECRET_PARAM);
  React.useEffect(() => {
    if (linked) setEditing({ name: linked });
  }, [linked]);
  const closeEditor = (): void => {
    setEditing(null);
    if (linked) setLinked("");
  };
  // The inventory lists the required secrets too, set or not.
  const rows = React.useMemo(
    () =>
      [...(secrets.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [secrets.data],
  );
  const configured = new Set(
    rows.filter((r) => r.configured).map((r) => r.name),
  );

  return (
    <SettingsSection
      id="keys-secrets"
      title="Secrets"
      description="Never shown again."
      actions={
        <Button
          size="sm"
          variant="outline"
          iconStart={<Plus aria-hidden />}
          onClick={() => setEditing({ name: "" })}
        >
          Set secret
        </Button>
      }
    >
      {secrets.isPending && rows.length === 0 ? (
        <div className="space-y-2 px-5 py-4" aria-label="secrets">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : secrets.isError && rows.length === 0 ? (
        <div className="px-5 py-4">
          <ErrorState
            compact
            error={secrets.error}
            onRetry={() => void secrets.refetch()}
          />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          kind="first-run"
          headingLevel={3}
          title="No secrets"
          description="Set a secret when a custom OIDC provider or an edge-mint recipe needs one. The manifest names which."
          primaryAction={
            <Button size="sm" onClick={() => setEditing({ name: "" })}>
              Set secret
            </Button>
          }
        />
      ) : (
        <ul aria-label="Secrets" className="divide-y divide-border">
          {rows.map((s) => (
            <li
              key={s.name}
              className="flex items-center justify-between gap-4 px-5 py-4 max-sm:flex-wrap"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium text-fg-strong [overflow-wrap:anywhere]">
                    {s.name}
                  </span>
                  <StatusPill
                    domain="secret"
                    state={s.configured ? "configured" : "missing"}
                    size="sm"
                  />
                </p>
                <p className="text-sm text-fg-muted">
                  {s.configured ? (
                    <>
                      {s.updatedAt ? (
                        <>
                          Set <Timestamp at={fromSeconds(s.updatedAt)} />
                        </>
                      ) : (
                        "Set"
                      )}
                    </>
                  ) : (
                    "No value"
                  )}
                </p>
                {s.usage ? (
                  <p className="text-sm text-fg-muted">{USAGE_TEXT[s.usage]}</p>
                ) : null}
                {neededBy(s.name, s.requiredBy).length ? (
                  <p className="text-sm text-fg-muted">
                    Needed by{" "}
                    <span>{neededBy(s.name, s.requiredBy).join(", ")}</span>.
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                aria-label={`${s.configured ? "Replace" : "Set value for"} ${s.name}`}
                onClick={() => setEditing({ name: s.name })}
              >
                {s.configured ? "Replace" : "Set value"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {secrets.isError && rows.length > 0 ? (
        <div className="px-5 pb-4">
          <Callout
            tone="warning"
            title="Showing required secrets only"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => void secrets.refetch()}
              >
                Try again
              </Button>
            }
          >
            The full list could not load. {errorCopy(secrets.error).description}{" "}
            <CopyDetails copy={errorCopy(secrets.error)} />
          </Callout>
        </div>
      ) : null}
      <SetSecretDrawer
        slug={slug}
        initialName={editing?.name ?? null}
        configured={configured}
        onClose={closeEditor}
      />
    </SettingsSection>
  );
}

function SetSecretDrawer({
  slug,
  initialName,
  configured,
  onClose,
}: {
  slug: string;
  /** `null`: closed. `""`: a new secret. */
  initialName: string | null;
  configured: Set<string>;
  onClose: () => void;
}): React.ReactElement {
  const open = initialName !== null;
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [usage, setUsage] = React.useState<UsageChoice>("keep");
  const [replace, setReplace] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; value?: string }>(
    {},
  );
  const [failure, setFailure] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(initialName ?? "");
      setValue("");
      setUsage("keep");
      setReplace(false);
      setErrors({});
      setFailure(null);
    }
  }, [open, initialName]);

  const exists = configured.has(name.trim());
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    const errs: { name?: string; value?: string } = {};
    if (!name.trim()) errs.name = "Enter the secret's name.";
    if (exists && !replace)
      errs.value = "Tick “Replace the existing value” to overwrite it.";
    else if (!value) errs.value = "Enter a value.";
    setErrors(errs);
    if (errs.name || errs.value) return;
    setSaving(true);
    setFailure(null);
    try {
      const secretName = name.trim();
      await mutate(
        "putProductSecret",
        slug,
        secretName,
        value,
        usage === "keep" ? undefined : usage,
      );
      toast.success(`Secret ${secretName} saved`);
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
      dismissible={!saving}
      unsaved={!saving && value !== ""}
      title={initialName ? `Set ${initialName}` : "Set secret"}
      description="Never shown again."
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <DrawerBody className="space-y-4">
          <FormField
            name="name"
            label="Name"
            required
            value={name}
            onChange={(v: string) => setName(v)}
            error={errors.name}
            announceError
          >
            {(f) => (
              <Input {...f} mono autoComplete="off" readOnly={!!initialName} />
            )}
          </FormField>
          <FormField
            name="value"
            label="Value"
            required
            value={value}
            onChange={(v: string) => setValue(v)}
            error={errors.value}
            announceError
          >
            {(f) => (
              <SecretInput
                {...f}
                value={value}
                onChange={setValue}
                configured={exists}
                replace={replace}
                onReplaceChange={setReplace}
              />
            )}
          </FormField>
          <FormField
            name="usage"
            label="Usage"
            help="Only a secret marked for edge-mint signing can sign edge-mint tokens. Keep current leaves an existing secret's usage as it is; a new secret is general."
            value={usage}
            onChange={(v: string) => setUsage(v as UsageChoice)}
          >
            {(f) => (
              <Select
                id={f.id}
                aria-describedby={f["aria-describedby"]}
                options={USAGE_CHOICES}
                value={usage}
                onChange={(v) => setUsage((v ?? "keep") as UsageChoice)}
              />
            )}
          </FormField>
          {failure ? (
            <Callout tone="danger" title={errorCopy(failure).title}>
              <p>{errorCopy(failure).description}</p>
              <div className="mt-2">
                <CopyDetails copy={errorCopy(failure)} />
              </div>
            </Callout>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save secret
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}
