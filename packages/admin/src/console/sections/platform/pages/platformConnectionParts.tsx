/**
 * The add wizard's pieces (I-31): the draft and its helpers, the test step, the review step and
 * the claims preview. The page that owns the steps and the requests is ./platformConnectionWizard.tsx.
 */

import * as React from "react";
import {
  type ClaimMapDto,
  type ConnectionTestResult,
} from "../../../../api.js";
import { Button } from "../../../../ui/Button.js";
import { SecretInput } from "../../../../ui/SecretInput.js";
import { FormField } from "../../../../ui/form.js";
import { Callout } from "../../../../ui/Callout.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { codecs } from "../../../router.js";
import type { Failure } from "./connectionErrors.js";
import { StepUpCallout } from "../../core/pages/UserRelink.js";

export const STEP_IDS = [
  "provider",
  "client",
  "test",
  "mapping",
  "save",
  "done",
] as const;
export type StepId = (typeof STEP_IDS)[number];
export const stepCodec = codecs.oneOf(STEP_IDS, "provider");
export const textCodec = codecs.string("");

export const DRAFT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const CHANNEL = "pkey-connection-test";
export const STORE_PREFIX = "pkey.connection-draft.";

export interface Draft {
  /** A secret was typed on the Client step (the secret itself is never stored). */
  hadSecret: boolean;
  label: string;
  issuer: string;
  clientId: string;
  groups: string;
  claims: string;
  name: string;
}
export const EMPTY: Draft = {
  hadSecret: false,
  label: "",
  issuer: "",
  clientId: "",
  groups: "",
  claims: "",
  name: "",
};

export const newDraftId = (): string => crypto.randomUUID().replace(/-/g, "");

export function loadDraft(id: string): Draft {
  try {
    const raw = sessionStorage.getItem(STORE_PREFIX + id);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** The claim map the draft's fields spell, in the shape the Worker validates. */
export function claimMapOf(
  d: Pick<Draft, "groups" | "claims" | "name">,
): ClaimMapDto {
  const out: ClaimMapDto = {};
  if (d.groups.trim()) out.groups = d.groups.trim();
  if (d.name.trim()) out.name = d.name.trim();
  const claims = d.claims
    .split(/[\s,]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (claims.length) out.claims = [...new Set(claims)];
  return out;
}

export const hostOf = (issuer: string): string => {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
};

export function TestStep({
  issuer,
  needsSecret,
  error,
  result,
  testing,
  onTab,
  onBackToClient,
}: {
  issuer: string;
  needsSecret: boolean;
  error: Failure | null;
  result: ConnectionTestResult | null;
  testing: boolean;
  onTab: () => void;
  onBackToClient: () => void;
}): React.ReactElement {
  const outcome = React.useRef<HTMLDivElement>(null);
  // The result (or the failure) arrives after a click; say so by moving focus to it.
  React.useEffect(() => {
    if (result || error) outcome.current?.focus();
  }, [result, error]);
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Sign in at {issuer ? hostOf(issuer) : "the provider"} to see which
        claims arrive. Nothing is saved.
      </p>
      {needsSecret && !result?.ok ? (
        <Callout tone="info" title="No client secret in this tab">
          Go back to Client and enter it again if the provider needs one.
        </Callout>
      ) : null}
      <div ref={outcome} tabIndex={-1} className="space-y-3 outline-none">
        {error ? (
          <Callout tone="danger" title={error.title} live>
            {error.description}
          </Callout>
        ) : null}
        {result ? <TestResultView result={result} /> : null}
        {(error &&
          error.code !== "popup_closed" &&
          error.code !== "popup_blocked") ||
        (result && !result.ok) ? (
          <Button variant="outline" size="sm" onClick={onBackToClient}>
            Back to Client
          </Button>
        ) : null}
      </div>
      {result?.ok ? null : (
        <Button variant="ghost" size="sm" disabled={testing} onClick={onTab}>
          Open in this tab instead
        </Button>
      )}
    </div>
  );
}

export function ReviewStep({
  draft,
  secret,
  onSecret,
  test,
  fresh,
  stepUpHash,
  error,
  secretMissing,
  onBackToClient,
}: {
  draft: Draft;
  secret: string;
  onSecret: (v: string) => void;
  test: ConnectionTestResult | null;
  fresh: boolean;
  stepUpHash: string;
  error: Failure | null;
  secretMissing: boolean;
  onBackToClient: () => void;
}): React.ReactElement {
  const failed = React.useRef<HTMLDivElement>(null);
  // A failed save puts focus on its words.
  React.useEffect(() => {
    if (error) failed.current?.focus();
  }, [error]);
  return (
    <div className="space-y-4">
      {fresh ? null : (
        <StepUpCallout hash={stepUpHash}>
          Adding a connection needs a sign-in from the last five minutes. You
          come back to this step.
        </StepUpCallout>
      )}
      {error ? (
        <div ref={failed} tabIndex={-1} className="outline-none">
          <Callout tone="danger" title={error.title} live>
            {error.description}
            {error.link ? (
              <>
                {" "}
                <a href={error.link.href} className="text-accent-fg underline">
                  {error.link.label}
                </a>
              </>
            ) : null}
          </Callout>
          {error.code === "exists" ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={onBackToClient}
            >
              Back to Client
            </Button>
          ) : null}
        </div>
      ) : null}
      {secretMissing || draft.hadSecret ? (
        <FormField
          name="clientSecret"
          label={
            secretMissing ? "Enter the client secret again" : "Client secret"
          }
          required={secretMissing}
          help={
            secretMissing
              ? "It is not kept between pages. Sealed when added and never shown again."
              : "Sealed when added and never shown again."
          }
          value={secret}
          onChange={onSecret}
        >
          {(f) => <SecretInput {...f} />}
        </FormField>
      ) : null}
      <DescriptionList
        items={[
          { term: "Name", detail: draft.label.trim() || hostOf(draft.issuer) },
          { term: "Issuer", detail: draft.issuer },
          { term: "Client ID", detail: draft.clientId },
          // One place: the field above holds the secret when one is expected.
          ...(secretMissing || draft.hadSecret
            ? []
            : [{ term: "Client secret", detail: "None" }]),
          { term: "Who signs in", detail: "Customers" },
          {
            term: "Test",
            detail: test ? (test.ok ? "Signed in" : "Failed") : "Not run",
          },
        ]}
      />
    </div>
  );
}

/** The claims a test sign-in brought back, as plain text. */
export function TestResultView({
  result,
}: {
  result: ConnectionTestResult;
}): React.ReactElement {
  if (!result.ok || !result.preview) {
    return (
      <Callout tone="danger" title="The sign-in failed" live>
        {/* Plain text from the provider: never markup. */}
        <span className="break-words">{result.message ?? "No details."}</span>
      </Callout>
    );
  }
  const p = result.preview;
  return (
    <div className="space-y-3">
      <Callout
        tone="success"
        title={`Signed in as ${p.email ?? p.name ?? "an account with no email"}`}
        live
      >
        {p.issuer}
      </Callout>
      <DescriptionList
        items={[
          { term: "Email", detail: p.email ?? "Not sent" },
          {
            term: "Email verified",
            detail:
              p.emailVerified === null
                ? "Not sent"
                : p.emailVerified
                  ? "Yes"
                  : "No",
          },
          { term: "Name", detail: p.name ?? "Not sent" },
          {
            term: "Groups",
            detail: p.groups
              ? p.groups.length
                ? p.groups.join(", ")
                : "None"
              : p.claimNames.includes("groups")
                ? "Not mapped yet"
                : "Not mapped",
          },
          {
            term: "Other claims",
            detail: p.claims
              ? Object.entries(p.claims)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ")
              : "Not mapped",
          },
          { term: "Claims in the token", detail: p.claimNames.join(", ") },
        ]}
      />
    </div>
  );
}
