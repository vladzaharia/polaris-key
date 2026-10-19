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
import { Callout } from "../../../../ui/Callout.js";
import { DescriptionList } from "../../../../ui/DescriptionList.js";
import { codecs } from "../../../router.js";
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

interface Draft {
  label: string;
  issuer: string;
  clientId: string;
  groups: string;
  claims: string;
  name: string;
}
export const EMPTY: Draft = {
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

export type { Draft };

export function TestStep({
  issuer,
  needsSecret,
  testing,
  error,
  result,
  onRun,
}: {
  issuer: string;
  needsSecret: boolean;
  testing: boolean;
  error: { title: string; description?: string } | null;
  result: ConnectionTestResult | null;
  onRun: (mode: "popup" | "tab") => void;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">
        Sign in at {hostOf(issuer)} to see which claims arrive. Nothing is
        saved.
      </p>
      {needsSecret ? (
        <Callout tone="info" title="No client secret in this tab">
          Enter it again on the Client step if the provider needs one.
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          loading={testing}
          onClick={() => onRun("popup")}
          variant="outline"
        >
          Test sign-in
        </Button>
        <Button variant="ghost" disabled={testing} onClick={() => onRun("tab")}>
          Use this tab
        </Button>
      </div>
      {error ? (
        <Callout tone="danger" title={error.title} live>
          {error.description}
        </Callout>
      ) : null}
      {result ? <TestResultView result={result} /> : null}
    </div>
  );
}

export function ReviewStep({
  draft,
  hasSecret,
  test,
  fresh,
  stepUpHash,
  error,
}: {
  draft: Draft;
  hasSecret: boolean;
  test: ConnectionTestResult | null;
  fresh: boolean;
  stepUpHash: string;
  error: { title: string; description?: string } | null;
}): React.ReactElement {
  return (
    <div className="space-y-4">
      {fresh ? null : (
        <StepUpCallout hash={stepUpHash}>
          Adding a connection needs a sign-in from the last five minutes. Enter
          the secret again after you return.
        </StepUpCallout>
      )}
      {error ? (
        <Callout tone="danger" title={error.title} live>
          {error.description}
        </Callout>
      ) : null}
      <DescriptionList
        items={[
          { term: "Name", detail: draft.label.trim() || hostOf(draft.issuer) },
          { term: "Issuer", detail: draft.issuer },
          { term: "Client ID", detail: draft.clientId },
          {
            term: "Client secret",
            detail: hasSecret ? "Sealed when added" : "None",
          },
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
      <Callout tone="success" title="Signed in" live>
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
