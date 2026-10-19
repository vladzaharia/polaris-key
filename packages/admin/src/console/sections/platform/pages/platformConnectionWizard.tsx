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
import {
  api,
  ApiError,
  type ConnectionDiscovery,
  type ConnectionTestResult,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { CopyButton } from "../../../../ui/CopyButton.js";
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
  CHANNEL,
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
  const [test, setTest] = React.useState<ConnectionTestResult | null>(null);
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
  const clientOk = /^[\x21-\x7e]{1,200}$/.test(draft.clientId.trim());

  const steps: WizardStep[] = CONNECTION_FLOW.steps.map((s) => ({
    id: s.id,
    label: s.label,
  }));
  const decided: Partial<Record<StepId, string | undefined>> = {
    provider: discovered
      ? `${draft.label.trim() || hostOf(draft.issuer)} · ${hostOf(draft.issuer)}`
      : undefined,
    client: clientOk ? draft.clientId.trim() : undefined,
    test: test ? (test.ok ? "Signed in" : "Failed") : undefined,
    mapping: claimMapOf(draft).groups
      ? `Groups from ${claimMapOf(draft).groups}`
      : undefined,
  };
  const wizardSteps = steps.map((s) => ({
    ...s,
    decided: decided[s.id as StepId],
  }));
  const completed: string[] = [];
  if (index > 0 && discovered) completed.push("provider");
  if (index > 1 && clientOk) completed.push("client");
  if (index > 2 && test) completed.push("test");
  if (index > 3) completed.push("mapping");
  if (created) completed.push("save");

  const titles: Record<StepId, string> = {
    provider: "Which provider?",
    client: "Register this app at the provider",
    test: "Sign in once to check it",
    mapping: "Which claims do you need?",
    save: "Add this connection?",
    done: "Connection added",
  };

  // ── the test sign-in ───────────────────────────────────────────────────────────────────────
  const pending = React.useRef<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [testError, setTestError] = React.useState<unknown>(null);

  const fetchResult = React.useCallback(
    async (state: string): Promise<void> => {
      try {
        const res = await api.connectionTestResult(state, draftId);
        setTest(res.result);
        setTestError(null);
      } catch (e) {
        setTestError(e);
      } finally {
        setTesting(false);
      }
    },
    [draftId],
  );

  // The tab that started the test hears the pop-up come back and fetches the result.
  React.useEffect(() => {
    if (!draftId || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type?: string; draftId?: string; state?: string };
      if (
        m?.type === "back" &&
        m.draftId === draftId &&
        m.state &&
        m.state === pending.current
      ) {
        ch.postMessage({ type: "ack", draftId, state: m.state });
        pending.current = null;
        void fetchResult(m.state);
      }
    };
    return () => ch.close();
  }, [draftId, fetchResult]);

  // This page is the pop-up (an opener answers) or the same-tab return (none does).
  const handled = React.useRef(false);
  React.useEffect(() => {
    if (!draftId || !returned || step !== "test" || handled.current) return;
    handled.current = true;
    const finish = (): void => void fetchResult(returned);
    if (typeof BroadcastChannel === "undefined") return finish();
    const ch = new BroadcastChannel(CHANNEL);
    let acked = false;
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type?: string; draftId?: string; state?: string };
      if (m?.type === "ack" && m.draftId === draftId && m.state === returned) {
        acked = true;
        window.close();
      }
    };
    ch.postMessage({ type: "back", draftId, state: returned });
    const t = window.setTimeout(() => {
      ch.close();
      if (!acked) finish();
    }, 700);
    return () => window.clearTimeout(t);
  }, [draftId, returned, step, fetchResult]);

  const runTest = async (mode: "popup" | "tab"): Promise<void> => {
    setTesting(true);
    setTestError(null);
    setTest(null);
    try {
      const res = await mutate("startConnectionTest", {
        draftId,
        issuer: draft.issuer.trim(),
        clientId: draft.clientId.trim(),
        ...(secret ? { clientSecret: secret } : {}),
        claimMap: claimMapOf(draft),
      });
      if (mode === "tab") {
        window.location.assign(res.url);
        return;
      }
      pending.current = res.state;
      const win = window.open(res.url, CHANNEL, "popup,width=520,height=720");
      if (!win) {
        pending.current = null;
        setTesting(false);
        setTestError(
          new Error("The pop-up was blocked. Use this tab instead."),
        );
      }
    } catch (e) {
      setTesting(false);
      setTestError(e);
    }
  };

  // ── discovery and save ──────────────────────────────────────────────────────────────────────
  const [checking, setChecking] = React.useState(false);
  const [providerError, setProviderError] = React.useState<unknown>(null);
  const check = async (): Promise<void> => {
    setChecking(true);
    setProviderError(null);
    try {
      const res = await mutate("discoverConnection", {
        issuer: draft.issuer.trim(),
      });
      setDiscovery({ issuer: draft.issuer.trim(), value: res.discovery });
    } catch (e) {
      setDiscovery(null);
      setProviderError(e);
    } finally {
      setChecking(false);
    }
  };

  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<unknown>(null);
  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await mutate("createPlatformConnection", {
        label: draft.label.trim() || hostOf(draft.issuer),
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
      if (e instanceof ApiError && e.code === "step_up_required") markStale();
      else setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  const failure = (
    e: unknown,
  ): { title: string; description?: string } | null =>
    e ? errorCopy(e, { thing: "The connection" }) : null;

  const back =
    index > 0 && step !== "done" ? () => go(STEP_IDS[index - 1]!) : undefined;
  const footer = {
    later: (
      <Button variant="ghost" asChild>
        <Link to={r.platformConnections()}>
          {step === "done" ? "Back to Connections" : "Do this later"}
        </Link>
      </Button>
    ),
    onBack: back,
  };

  const next = (disabledReason?: string, to?: StepId): React.ReactElement => (
    <Button
      disabledReason={disabledReason}
      onClick={() => go(to ?? STEP_IDS[index + 1]!)}
    >
      Continue
      <ArrowRight aria-hidden />
    </Button>
  );

  return (
    <div className="space-y-6">
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
        label="Add a connection"
        steps={wizardSteps}
        current={step}
        done={completed}
        visited={STEP_IDS.slice(0, index) as unknown as string[]}
        onStep={(id) => id !== "done" && !created && go(id as StepId)}
        title={titles[step]}
        focusOnMount
        footer={
          step === "provider"
            ? {
                ...footer,
                primary: next(
                  !gate.allowed
                    ? gate.disabledReason
                    : !discovered
                      ? "Check the provider to continue"
                      : undefined,
                ),
                reason: !discovered
                  ? "Check the provider to continue"
                  : undefined,
              }
            : step === "client"
              ? {
                  ...footer,
                  primary: next(clientOk ? undefined : "Enter the client ID"),
                  reason: clientOk ? undefined : "Enter the client ID",
                }
              : step === "test"
                ? { ...footer, primary: next() }
                : step === "mapping"
                  ? { ...footer, primary: next() }
                  : step === "save"
                    ? {
                        ...footer,
                        primary: (
                          <Button
                            loading={saving}
                            disabledReason={
                              !gate.allowed
                                ? gate.disabledReason
                                : !fresh
                                  ? "Sign in again to continue"
                                  : undefined
                            }
                            onClick={() => void save()}
                          >
                            Add connection
                          </Button>
                        ),
                      }
                    : { later: footer.later }
        }
      >
        {step === "provider" ? (
          <FormStep
            formId="connection-provider"
            onSubmit={() => void check()}
            error={failure(providerError)}
          >
            {fresh ? null : (
              <StepUpCallout hash={r.platformConnectionNew()}>
                Adding a connection needs a sign-in from the last five minutes.
                You come back to this page afterwards.
              </StepUpCallout>
            )}
            <FormField
              name="issuer"
              label="Issuer"
              required
              help="The provider's https address, as it appears in its discovery document."
              value={draft.issuer}
              onChange={(v: string) => setDraft({ issuer: v })}
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
                type="submit"
                variant="outline"
                loading={checking}
                disabledReason={
                  draft.issuer.trim() ? undefined : "Enter the issuer"
                }
              >
                Check provider
              </Button>
              {discovered ? (
                <StatusPill tone="success" size="sm">
                  Found
                </StatusPill>
              ) : null}
            </div>
            {discovery && discovered ? (
              <DescriptionList
                items={[
                  {
                    term: "Sign-in page",
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
              <p className="text-sm font-medium text-fg-strong">Redirect URI</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-surface-sunken px-2 py-1 text-xs">
                  {discovery?.value.redirectUri ??
                    `${window.location.origin}/callback`}
                </code>
                <CopyButton
                  value={
                    discovery?.value.redirectUri ??
                    `${window.location.origin}/callback`
                  }
                  label="redirect URI"
                />
              </div>
              <p className="text-xs text-fg-muted">
                Register it at the provider as an allowed redirect.
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
              onChange={(v: string) => setSecret(v)}
            >
              {(f) => <SecretInput {...f} />}
            </FormField>
          </FormStep>
        ) : null}

        {step === "test" ? (
          <TestStep
            issuer={draft.issuer}
            needsSecret={!secret && Boolean(draft.clientId)}
            testing={testing}
            error={failure(testError)}
            result={test}
            onRun={(mode) => void runTest(mode)}
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
            hasSecret={Boolean(secret)}
            test={test}
            fresh={fresh}
            stepUpHash={r.platformConnectionNew({
              step: "save",
              draft: draftId,
            })}
            error={failure(saveError)}
          />
        ) : null}

        {step === "done" ? (
          <DoneStep
            result="Connection added"
            detail="Claim a domain to send its addresses here."
            next={
              created
                ? [
                    <Button key="open" asChild>
                      <Link to={r.platformConnection(created)}>
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
