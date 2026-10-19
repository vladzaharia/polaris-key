/**
 * One connection's domains (I-31): the TXT record to publish, a live check, enforcement and
 * release. A refusal is shown on the domain field; a release of a verified domain says what it
 * changes first.
 */

import * as React from "react";
import type { ConnectionDomain, PlatformConnection } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { Section } from "../../../../ui/Section.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { toast } from "../../../../ui/toast.js";
import { mutate } from "../../../data/mutations.js";
import { failureOf, fieldMessage, focusField } from "./connectionErrors.js";

export type Act = (fn: () => Promise<unknown>) => Promise<void>;

function RecordLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-fg-muted">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded-md bg-surface-sunken px-2 py-1 text-xs">
        {value}
      </code>
      <CopyButton value={value} label={label.toLowerCase()} />
    </div>
  );
}

const CHECK_WORDS: Record<string, string> = {
  verified: "Verified.",
  taken: "Another connection already owns this domain.",
  error: "The DNS lookup failed. Try again.",
  absent: "Record not found yet. DNS can take a while.",
};

export function DomainsSection({
  c,
  writeReason,
  act,
  focusAdd,
  onEnforce,
}: {
  c: PlatformConnection;
  writeReason: string | undefined;
  /** Runs a write and refreshes the page; rethrows so the caller can show the words. */
  act: Act;
  focusAdd: boolean;
  onEnforce: (d: ConnectionDomain) => void;
}): React.ReactElement {
  const [domain, setDomain] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [checked, setChecked] = React.useState<Record<string, string>>({});
  const [releasing, setReleasing] = React.useState<ConnectionDomain | null>(
    null,
  );
  const fail = failureOf(error);

  // "Add a domain" from the wizard's last step lands on the field.
  React.useEffect(() => {
    if (focusAdd) focusField("domain");
  }, [focusAdd]);

  /** One row's write: only its own button spins, a refusal lands on the domain field. */
  const run = async (
    key: string,
    fn: () => Promise<unknown>,
  ): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await act(fn);
      return true;
    } catch (e) {
      setError(e);
      if (failureOf(e)?.fields.includes("domain")) focusField("domain");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const release = (d: ConnectionDomain): void => {
    void run(`release:${d.domain}`, () =>
      mutate("removeConnectionDomain", c.id, d.domain),
    ).then((ok) => {
      if (ok && !d.verified) {
        toast.success(`Released ${d.domain}`, {
          action: {
            label: "Undo",
            onClick: () =>
              void mutate("addConnectionDomain", c.id, d.domain).then(() =>
                act(async () => undefined),
              ),
          },
        });
      }
    });
  };

  return (
    <Section
      title="Domains"
      description="Addresses at a verified domain sign in through this connection. Each domain, subdomains included, is its own entry."
    >
      {c.domains.length === 0 ? (
        <EmptyState
          kind="first-run"
          variant="inline"
          title="No domains"
          description="Add a domain, then publish the TXT record to prove you own it."
        />
      ) : (
        <ul className="divide-y divide-border">
          {c.domains.map((d) => (
            <li key={d.domain} className="space-y-3 py-3">
              <div className="grid items-center gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <span className="break-all font-medium text-fg-strong">
                  {d.domain}
                </span>
                <StatusPill tone={d.verified ? "success" : "warning"} size="sm">
                  {d.verified ? "Verified" : "Not verified"}
                </StatusPill>
                <div className="flex flex-wrap items-center gap-2">
                  {d.verified ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busy === `check:${d.domain}`}
                      disabledReason={writeReason}
                      onClick={() =>
                        void run(`check:${d.domain}`, async () => {
                          const res = await mutate(
                            "verifyConnectionDomain",
                            c.id,
                            d.domain,
                          );
                          setChecked((s) => ({
                            ...s,
                            [d.domain]: CHECK_WORDS[res.verify ?? "absent"]!,
                          }));
                        }).then(() =>
                          window.setTimeout(
                            () =>
                              document
                                .getElementById(`domain-status-${d.domain}`)
                                ?.focus(),
                            0,
                          ),
                        )
                      }
                    >
                      Check now
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    loading={busy === `release:${d.domain}`}
                    disabledReason={writeReason}
                    onClick={() => (d.verified ? setReleasing(d) : release(d))}
                  >
                    Release
                  </Button>
                </div>
              </div>
              {d.verified ? (
                <Switch
                  checked={d.enforce}
                  label="Require this connection"
                  description="No email codes or magic links for this domain."
                  disabled={Boolean(busy) || Boolean(writeReason)}
                  onCheckedChange={() => onEnforce(d)}
                />
              ) : (
                <div className="space-y-1 text-sm">
                  <p>Publish this TXT record, then check it.</p>
                  <RecordLine label="Name" value={d.record.name} />
                  <RecordLine label="Value" value={d.record.value} />
                  <p
                    id={`domain-status-${d.domain}`}
                    role="status"
                    tabIndex={-1}
                    className="text-fg-muted outline-none"
                  >
                    {checked[d.domain] ?? ""}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!domain.trim()) return;
          void run("add", () =>
            mutate("addConnectionDomain", c.id, domain.trim()),
          ).then((ok) => ok && setDomain(""));
        }}
      >
        <FormField
          name="domain"
          label="Add a domain"
          className="min-w-[14rem] flex-1"
          value={domain}
          error={fieldMessage(fail, "domain")}
          announceError
          onChange={(v: string) => setDomain(v)}
        >
          {(f) => (
            <Input
              {...f}
              placeholder="example.com"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </FormField>
        <Button
          type="submit"
          className="sm:mt-6"
          loading={busy === "add"}
          disabledReason={
            writeReason ?? (domain.trim() ? undefined : "Enter a domain")
          }
        >
          Add domain
        </Button>
      </form>
      {fail && fail.fields.length === 0 ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {fail.title}. {fail.description}
        </p>
      ) : null}
      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(o) => !o && setReleasing(null)}
        intent="caution"
        title={`Release ${releasing?.domain ?? ""}?`}
        consequences={[
          `Addresses at ${releasing?.domain ?? "this domain"} go back to email codes and no longer route here.`,
          c.links > 0
            ? `${c.links} ${c.links === 1 ? "person signs" : "people sign"} in through ${c.label}. They keep their accounts.`
            : "Nobody signs in through it yet.",
          "Claiming it again needs a new TXT record.",
        ]}
        confirmLabel="Release domain"
        describeError={(e) => failureOf(e)!}
        onConfirm={async () => {
          if (!releasing) return;
          await act(() =>
            mutate("removeConnectionDomain", c.id, releasing.domain),
          );
        }}
      />
    </Section>
  );
}
