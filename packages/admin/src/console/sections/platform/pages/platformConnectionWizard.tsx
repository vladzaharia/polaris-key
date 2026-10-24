/**
 * Platform → Connections → Add connection (I-31), on the wizard kit (ST-39).
 *
 * Five steps, nothing saved until the last: the provider is checked (discovery runs in the
 * Worker, through the gated fetch), the client is entered (the secret stays in this tab's memory
 * and is sealed on save), a test sign-in shows which claims arrive, the mapping is set, and Add
 * writes the row. The draft's plain fields survive a reload in `sessionStorage` (never the
 * secret); the step is a search param, so a refresh resumes.
 *
 * Test sign-in. The provider opens in a pop-up. The result reaches only this tab: the pop-up
 * comes back to this page, finds this tab on a BroadcastChannel (keyed by the draft id) and
 * closes; this tab then fetches the result once with the operator's session. With no pop-up (a
 * blocker, a phone) the same tab goes to the provider and returns to the same step.
 */

import * as React from "react";
import { ArrowRight } from "lucide-react";
import { HttpError, type ConnectionDiscovery } from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { useMe } from "../../../data/hooks.js";
import { RegisterAddresses, registerAt } from "./RegisterAddresses.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import {
  DoneStep,
  FormStep,
  Wizard,
  type WizardStep,
} from "../../../../ui/wizard/index.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { mutate } from "../../../data/mutations.js";
import { Link, useSearchParam } from "../../../router.js";
import { r } from "../../../routes.js";
import { CONNECTION_FLOW } from "../../../wizard/flows.js";
import { StepUpCallout, useStepUp } from "../../core/pages/UserRelink.js";
import {
  PopupBlockedError,
  PopupClosedError,
  failureOf,
  fieldMessage,
  focusField,
} from "./connectionErrors.js";
import { useConnectionTest } from "./useConnectionTest.js";
import {
  DRAFT_ID_RE,
  STEP_IDS,
  STORE_PREFIX,
  ReviewStep,
  TestStep,
  claimMapOf,
  hostOf,
  loadDraft,
  newDraftId,
  stepCodec,
  textCodec,
  type Draft,
  type StepId,
} from "./platformConnectionParts.js";

export function AddConnectionPage(): React.ReactElement {
  const me = useMe();
  const [step, setStep] = useSearchParam("step", stepCodec, { replace: false });
  const [draftParam, setDraftParam] = useSearchParam("draft", textCodec);
  const [returned] = useSearchParam("state", textCodec);
  const draftId = DRAFT_ID_RE.test(draftParam) ? draftParam : "";
  React.useEffect(() => {
    if (!draftId) setDraftParam(newDraftId());
  }, [draftId, setDraftParam]);

  const gate = useWriteGate("platform");
  const { fresh, markStale } = useStepUp(true);
  const [draft, setDraftState] = React.useState<Draft>(() =>
    loadDraft(draftId),
  );
  const [secret, setSecret] = React.useState("");
  const [discovery, setDiscovery] = React.useState<{
    issuer: string;
    value: ConnectionDiscovery;
  } | null>(null);
  const [created, setCreated] = React.useState<string | null>(null);

  const setDraft = (patch: Partial<Draft>): void => {
    setDraftState((d) => {
      const next = { ...d, ...patch };
      try {
        sessionStorage.setItem(STORE_PREFIX + draftId, JSON.stringify(next));
      } catch {
        // Storage off: the draft lives in this tab only.
      }
      return next;
    });
  };

  const index = STEP_IDS.indexOf(step);
  const go = (s: StepId): void => setStep(s);
  const discovered = discovery?.issuer === draft.issuer.trim();
  const clientAddresses = registerAt(
    discovery?.value.redirectUri ?? `${window.location.origin}/callback`,
    me.data?.customerOrigin ?? null,
  );
  const clientOk = /^[\x21-\x7e]{1,200}$/.test(draft.clientId.trim());
  const name = draft.label.trim() || hostOf(draft.issuer);

  const t = useConnectionTest({
    draftId,
    issuer: draft.issuer,
    clientId: draft.clientId,
    secret,
    claimMap: claimMapOf(draft),
    returned,
    onTestStep: step === "test",
  });
  const test = t.test;

  // The mapping starts from what the token carried.
  React.useEffect(() => {
    if (
      step === "mapping" &&
      test?.ok &&
      !draft.groups &&
      test.preview?.claimNames.includes("groups")
    ) {
      setDraft({ groups: "groups" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, test]);

  const decided: Partial<Record<StepId, string | undefined>> = {
    provider: discovered ? name : undefined,
    client: clientOk ? draft.clientId.trim() : undefined,
    test: test ? (test.ok ? "Signed in" : "Failed") : undefined,
    mapping: claimMapOf(draft).groups
      ? `Groups from ${claimMapOf(draft).groups}`
      : undefined,
  };
  const wizardSteps: WizardStep[] = CONNECTION_FLOW.steps.map((s) => ({
    id: s.id,
    label: s.label,
    decided: decided[s.id as StepId],
  }));
  const completed: string[] = [];
  if (index > 0 && discovered) completed.push("provider");
  if (index > 1 && clientOk) completed.push("client");
  if (index > 2 && test?.ok) completed.push("test");
  if (index > 3) completed.push("mapping");
  if (created) completed.push("save");

  const titles: Record<StepId, string> = {
    provider: "Which provider?",
    client: "Register Polaris Key at the provider",
    test: "Sign in once to check it",
    mapping: "Which claims do you need?",
    save: "Add this connection?",
    done: "Connection added",
  };

  // ── discovery ──────────────────────────────────────────────────────────────────────────────
  const [checking, setChecking] = React.useState(false);
  const [providerError, setProviderError] = React.useState<unknown>(null);
  const checkBtn = React.useRef<HTMLButtonElement>(null);
  const check = async (): Promise<void> => {
    setChecking(true);
    setProviderError(null);
    try {
      const res = await mutate("discoverConnection", {
        issuer: draft.issuer.trim(),
      });
      setDiscovery({ issuer: draft.issuer.trim(), value: res.discovery });
      window.setTimeout(() => checkBtn.current?.focus(), 0);
    } catch (e) {
      setDiscovery(null);
      setProviderError(e);
      if (failureOf(e)?.fields.includes("issuer")) focusField("issuer");
      else window.setTimeout(() => checkBtn.current?.focus(), 0);
    } finally {
      setChecking(false);
    }
  };

  // ── save ───────────────────────────────────────────────────────────────────────────────────
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const secretMissing = draft.hadSecret && !secret;
  const save = async (): Promise<void> => {
    if (saving || secretMissing) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await mutate("createPlatformConnection", {
        label: name,
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        ...(secret ? { clientSecret: secret } : {}),
        claimMap: claimMapOf(draft),
      });
      setSecret("");
      try {
        sessionStorage.removeItem(STORE_PREFIX + draftId);
      } catch {
        // Nothing to clear.
      }
      setCreated(res.connection.id);
      go("done");
    } catch (e) {
      if (e instanceof HttpError && e.code === "step_up_required") markStale();
      else setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const primaryRef = React.useRef<HTMLButtonElement>(null);
  // A pop-up that closed or never opened: the way to try again gets focus.
  React.useEffect(() => {
    if (
      t.error instanceof PopupClosedError ||
      t.error instanceof PopupBlockedError
    )
      window.setTimeout(() => primaryRef.current?.focus(), 0);
  }, [t.error]);
  const providerFailure = failureOf(providerError);
  const cancel = (
    <Button variant="ghost" asChild>
      <Link to={r.platformConnections()}>Cancel</Link>
    </Button>
  );
  const next = (disabledReason?: string): React.ReactElement => (
    <Button
      disabledReason={disabledReason}
      onClick={() => go(STEP_IDS[index + 1]!)}
    >
      Continue
      <ArrowRight aria-hidden />
    </Button>
  );
  const base = {
    later: cancel,
    onBack:
      index > 0 && step !== "done" ? () => go(STEP_IDS[index - 1]!) : undefined,
  };
  const providerReason = !gate.allowed
    ? gate.disabledReason
    : !discovered
      ? "Check the provider to continue"
      : undefined;
  const footer =
    step === "provider"
      ? { ...base, primary: next(providerReason), reason: providerReason }
      : step === "client"
        ? {
            ...base,
            primary: next(clientOk ? undefined : "Enter the client ID"),
            reason: clientOk ? undefined : "Enter the client ID",
          }
        : step === "test"
          ? {
              ...base,
              primary: test?.ok ? (
                next()
              ) : (
                <Button loading={t.testing} onClick={() => void t.run("popup")}>
                  {t.testing
                    ? `Waiting for ${name}…`
                    : test || t.error
                      ? "Try again"
                      : `Sign in with ${name}`}
                </Button>
              ),
              reason: test?.ok ? undefined : "Sign in to continue",
            }
          : step === "mapping"
            ? { ...base, primary: next() }
            : step === "save"
              ? {
                  ...base,
                  primary: (
                    <Button
                      loading={saving}
                      disabledReason={
                        !gate.allowed
                          ? gate.disabledReason
                          : !fresh
                            ? "Sign in again to continue"
                            : secretMissing
                              ? "Enter the client secret"
                              : undefined
                      }
                      onClick={() => void save()}
                    >
                      Add connection
                    </Button>
                  ),
                }
              : {};

  return (
    <div className="mx-auto w-full max-w-[60rem] space-y-6">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Connections", to: r.platformConnections() },
              { label: "Add connection" },
            ]}
          />
        }
        title="Add a connection"
        description="People sign in to apps with this provider."
      />
      <Wizard
        centered={false}
        label="Add a connection"
        steps={wizardSteps}
        current={step}
        done={completed}
        visited={STEP_IDS.slice(0, index) as unknown as string[]}
        onStep={(id) => id !== "done" && !created && go(id as StepId)}
        title={titles[step]}
        focusOnMount
        footer={footer}
      >
        {step === "provider" ? (
          <FormStep
            formId="connection-provider"
            onSubmit={() => void check()}
            error={
              providerFailure && providerFailure.fields.length === 0
                ? providerFailure
                : null
            }
          >
            {fresh ? null : (
              <StepUpCallout hash={r.platformConnectionNew({ draft: draftId })}>
                Adding a connection needs a sign-in from the last five minutes.
                You come back to this page with your entries.
              </StepUpCallout>
            )}
            <FormField
              name="issuer"
              label="Issuer"
              required
              help="The provider's https address, as it appears in its discovery document."
              value={draft.issuer}
              error={fieldMessage(providerFailure, "issuer")}
              announceError
              onChange={(v: string) => {
                setProviderError(null);
                setDraft({ issuer: v });
              }}
            >
              {(f) => (
                <Input
                  {...f}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://sso.example.com"
                />
              )}
            </FormField>
            <FormField
              name="label"
              label="Name"
              help="The sign-in button says Continue with this name."
              value={draft.label}
              onChange={(v: string) => setDraft({ label: v })}
            >
              {(f) => (
                <Input {...f} maxLength={60} placeholder="Work account" />
              )}
            </FormField>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                ref={checkBtn}
                type="submit"
                variant="outline"
                loading={checking}
                disabledReason={
                  !gate.allowed
                    ? gate.disabledReason
                    : draft.issuer.trim()
                      ? undefined
                      : "Enter the issuer"
                }
              >
                Check provider
              </Button>
              {discovered ? (
                <p role="status">
                  <StatusPill tone="success" size="sm">
                    Found
                  </StatusPill>
                </p>
              ) : null}
            </div>
            {discovery && discovered ? (
              <DescriptionList
                items={[
                  {
                    term: "Sign-in host",
                    detail: discovery.value.authorizationHost,
                  },
                  { term: "Token endpoint", detail: discovery.value.tokenHost },
                  { term: "Keys", detail: discovery.value.jwksHost },
                ]}
              />
            ) : null}
          </FormStep>
        ) : null}

        {step === "client" ? (
          <FormStep
            formId="connection-client"
            onSubmit={() => clientOk && go("test")}
          >
            <div className="space-y-1">
              <RegisterAddresses
                title="Redirect URI"
                copyLabel="Copy redirect URI"
                inline
                addresses={clientAddresses}
              />
              <p className="text-xs text-fg-muted">
                {clientAddresses.length > 1
                  ? "Register them at the provider as allowed redirects."
                  : "Register it at the provider as an allowed redirect."}
              </p>
            </div>
            <FormField
              name="clientId"
              label="Client ID"
              required
              value={draft.clientId}
              onChange={(v: string) => setDraft({ clientId: v })}
            >
              {(f) => <Input {...f} autoComplete="off" spellCheck={false} />}
            </FormField>
            <FormField
              name="clientSecret"
              label="Client secret"
              optional
              help="Sealed when saved and never shown again. Leave it empty for a public client."
              value={secret}
              onChange={(v: string) => {
                setSecret(v);
                setDraft({ hadSecret: v !== "" });
              }}
            >
              {(f) => <SecretInput {...f} />}
            </FormField>
          </FormStep>
        ) : null}

        {step === "test" ? (
          <TestStep
            issuer={draft.issuer}
            needsSecret={!secret && draft.hadSecret}
            testing={t.testing}
            error={failureOf(t.error)}
            result={test}
            onTab={() => void t.run("tab")}
            onBackToClient={() => go("client")}
          />
        ) : null}

        {step === "mapping" ? (
          <FormStep formId="connection-mapping" onSubmit={() => go("save")}>
            <datalist id="claim-names">
              {(test?.preview?.claimNames ?? []).map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <FormField
              name="groups"
              label="Groups claim"
              optional
              help="The claim that lists a person's groups. Access rules can name them."
              value={draft.groups}
              onChange={(v: string) => setDraft({ groups: v })}
            >
              {(f) => <Input {...f} list="claim-names" placeholder="groups" />}
            </FormField>
            <FormField
              name="claims"
              label="Other claims for access rules"
              optional
              help="Names separated by commas. Only these are kept."
              value={draft.claims}
              onChange={(v: string) => setDraft({ claims: v })}
            >
              {(f) => (
                <Input {...f} list="claim-names" placeholder="department" />
              )}
            </FormField>
            <FormField
              name="name"
              label="Name claim"
              optional
              help="Used to suggest a display name at sign-in."
              value={draft.name}
              onChange={(v: string) => setDraft({ name: v })}
            >
              {(f) => <Input {...f} list="claim-names" placeholder="name" />}
            </FormField>
          </FormStep>
        ) : null}

        {step === "save" ? (
          <ReviewStep
            draft={draft}
            secret={secret}
            onSecret={setSecret}
            secretMissing={secretMissing}
            onBackToClient={() => go("client")}
            test={test}
            fresh={fresh}
            stepUpHash={r.platformConnectionNew({
              step: "save",
              draft: draftId,
            })}
            error={failureOf(saveError)}
          />
        ) : null}

        {step === "done" ? (
          <DoneStep
            result={`${name} is on the sign-in card`}
            detail="Claim a domain to send its addresses here."
            next={
              created
                ? [
                    <Button key="open" asChild>
                      <Link
                        to={r.platformConnection(created, { add: "domain" })}
                      >
                        Add a domain
                      </Link>
                    </Button>,
                    <Button key="all" variant="outline" asChild>
                      <Link to={r.platformConnections()}>All connections</Link>
                    </Button>,
                  ]
                : undefined
            }
          />
        ) : null}
      </Wizard>
    </div>
  );
}
