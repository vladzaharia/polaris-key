/** The Change dialog of one connection (I-31): name, client, a new sealed secret, the claim mapping. */

import * as React from "react";
import { type ClaimMapDto, type PlatformConnection } from "../../../../api.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { mutate } from "../../../data/mutations.js";
import { claimMapOf } from "./platformConnectionParts.js";

// ── one connection ───────────────────────────────────────────────────────────────────────────

export function EditDialog({
  c,
  open,
  onClose,
  run,
}: {
  c: PlatformConnection;
  open: boolean;
  onClose: () => void;
  run: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
}): React.ReactElement {
  const [label, setLabel] = React.useState(c.label);
  const [clientId, setClientId] = React.useState(c.clientId);
  const [secret, setSecret] = React.useState("");
  const [groups, setGroups] = React.useState(c.claimMap.groups ?? "");
  const [claims, setClaims] = React.useState(
    c.claimMap.claims?.join(", ") ?? "",
  );
  const [name, setName] = React.useState(c.claimMap.name ?? "");
  React.useEffect(() => {
    if (open) {
      setLabel(c.label);
      setClientId(c.clientId);
      setSecret("");
      setGroups(c.claimMap.groups ?? "");
      setClaims(c.claimMap.claims?.join(", ") ?? "");
      setName(c.claimMap.name ?? "");
    }
  }, [open, c]);
  const seeded = c.source === "env";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Change ${c.label}`}
      confirmLabel="Save"
      confirmVariant="primary"
      onConfirm={async () => {
        const claimMap: ClaimMapDto = claimMapOf({ groups, claims, name });
        const ok = await run(
          () =>
            mutate("updatePlatformConnection", c.id, {
              label,
              ...(seeded ? {} : { clientId }),
              ...(secret ? { clientSecret: secret } : {}),
              claimMap,
            }),
          "Saved",
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-4">
        <FormField
          name="label"
          label="Name"
          value={label}
          onChange={(v: string) => setLabel(v)}
        >
          {(f) => <Input {...f} maxLength={60} />}
        </FormField>
        <FormField
          name="clientId"
          label="Client ID"
          help={seeded ? "The seeded connection keeps its client." : undefined}
          value={clientId}
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
          onChange={(v: string) => setSecret(v)}
        >
          {(f) => <SecretInput {...f} />}
        </FormField>
        <FormField
          name="groups"
          label="Groups claim"
          optional
          value={groups}
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
          onChange={(v: string) => setClaims(v)}
        >
          {(f) => <Input {...f} />}
        </FormField>
        <FormField
          name="name"
          label="Name claim"
          optional
          value={name}
          onChange={(v: string) => setName(v)}
        >
          {(f) => <Input {...f} />}
        </FormField>
      </div>
    </ConfirmDialog>
  );
}
