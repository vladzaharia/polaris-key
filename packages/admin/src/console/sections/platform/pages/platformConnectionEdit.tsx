/**
 * The Change dialog of one connection (I-31): name, client, a new sealed secret, the claim
 * mapping. A refused save keeps the dialog and every typed value, with the words on the field.
 */

import * as React from "react";
import type { PlatformConnection } from "../../../../api.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { mutate } from "../../../data/mutations.js";
import { failureOf, fieldMessage, type Failure } from "./connectionErrors.js";
import { claimMapOf } from "./platformConnectionParts.js";
import type { Act } from "./platformConnectionDomains.js";

export function EditDialog({
  c,
  open,
  onClose,
  act,
}: {
  c: PlatformConnection;
  open: boolean;
  onClose: () => void;
  act: Act;
}): React.ReactElement {
  const [label, setLabel] = React.useState(c.label);
  const [clientId, setClientId] = React.useState(c.clientId);
  const [secret, setSecret] = React.useState("");
  const [groups, setGroups] = React.useState(c.claimMap.groups ?? "");
  const [claims, setClaims] = React.useState(
    c.claimMap.claims?.join(", ") ?? "",
  );
  const [name, setName] = React.useState(c.claimMap.name ?? "");
  const [fail, setFail] = React.useState<Failure | null>(null);
  // Values reset when the dialog opens, never when a save fails or the page refetches.
  React.useEffect(() => {
    if (open) {
      setLabel(c.label);
      setClientId(c.clientId);
      setSecret("");
      setGroups(c.claimMap.groups ?? "");
      setClaims(c.claimMap.claims?.join(", ") ?? "");
      setName(c.claimMap.name ?? "");
      setFail(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const seeded = c.source === "env";
  const at = (f: string): string | undefined => fieldMessage(fail, f);
  const field = (f: string): string | undefined =>
    at(f) ?? (f === "groups" ? at("claimMap.groups") : at(`claimMap.${f}`));
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Change ${c.label}`}
      confirmLabel="Save"
      confirmVariant="primary"
      describeError={(e) =>
        fail && fail.fields.length > 0
          ? { title: "Not saved. Check the marked field." }
          : failureOf(e)!
      }
      onConfirm={async () => {
        setFail(null);
        try {
          await act(() =>
            mutate("updatePlatformConnection", c.id, {
              label,
              ...(seeded ? {} : { clientId }),
              ...(secret ? { clientSecret: secret } : {}),
              claimMap: claimMapOf({ groups, claims, name }),
            }),
          );
        } catch (e) {
          const f = failureOf(e);
          setFail(f);
          // A refusal about a field is shown on it, with the dialog and the typed values kept.
          if (f && f.fields.length > 0) {
            window.setTimeout(
              () =>
                document
                  .querySelector<HTMLElement>(
                    `[role=alertdialog] [name="${f.fields[0]!.replace("claimMap.", "")}"]`,
                  )
                  ?.focus(),
              0,
            );
            throw new Error(f.description ?? f.title);
          }
          throw e;
        }
      }}
    >
      <div className="space-y-4">
        <FormField
          name="label"
          label="Name"
          value={label}
          error={field("label")}
          onChange={(v: string) => setLabel(v)}
        >
          {(f) => <Input {...f} maxLength={60} />}
        </FormField>
        <FormField
          name="clientId"
          label="Client ID"
          help={seeded ? "The seeded connection keeps its client." : undefined}
          value={clientId}
          error={field("clientId")}
          onChange={(v: string) => setClientId(v)}
        >
          {(f) => <Input {...f} disabled={seeded} />}
        </FormField>
        <FormField
          name="clientSecret"
          label="New client secret"
          optional
          help="Replaces the sealed one. It is never shown again."
          value={secret}
          error={field("clientSecret")}
          onChange={(v: string) => setSecret(v)}
        >
          {(f) => <SecretInput {...f} />}
        </FormField>
        <FormField
          name="groups"
          label="Groups claim"
          optional
          value={groups}
          error={field("groups")}
          onChange={(v: string) => setGroups(v)}
        >
          {(f) => <Input {...f} />}
        </FormField>
        <FormField
          name="claims"
          label="Other claims for access rules"
          optional
          help="Names separated by commas."
          value={claims}
          error={field("claims")}
          onChange={(v: string) => setClaims(v)}
        >
          {(f) => <Input {...f} />}
        </FormField>
        <FormField
          name="name"
          label="Name claim"
          optional
          value={name}
          error={field("name")}
          onChange={(v: string) => setName(v)}
        >
          {(f) => <Input {...f} />}
        </FormField>
      </div>
    </ConfirmDialog>
  );
}
