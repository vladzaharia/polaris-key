import * as React from "react";
import { ArrowRight, Check } from "lucide-react";
import { RELEASE_PLATFORMS } from "@polaris-key/manifest";
import { DOCS_LINKS } from "../../../../lib/docsLinks.js";
import type { ErrorCopy, ErrorFix } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { AutoList, FormStep } from "../../../../ui/wizard/index.js";
import {
  FEATURES,
  SERVICE_TABLE,
  type FeatureId,
} from "../../../../services.generated.js";
import {
  RECOMMENDED,
  planFor,
  type ProductDraft,
} from "../model/newProduct.js";

// ── Name ─────────────────────────────────────────────────────────────────────────────────────

/** The name step: the name first, the slug follows it and is checked (W24). */
export function NameStep({
  name,
  slug,
  onName,
  onSlug,
  onSubmit,
  errors,
  available,
  suggestion,
  checking,
  onUseSuggestion,
}: {
  name: string;
  slug: string;
  onName: (v: string) => void;
  onSlug: (v: string) => void;
  onSubmit: () => void;
  errors: { name?: string; slug?: string };
  available: boolean;
  suggestion: string | null;
  checking: boolean;
  onUseSuggestion: (slug: string) => void;
}): React.ReactElement {
  return (
    <FormStep formId="np-name" onSubmit={onSubmit}>
      {/* Two text fields and no submit button inside the form: Enter would do nothing. */}
      <button type="submit" tabIndex={-1} aria-hidden className="sr-only" />
      <FormField
        name="name"
        label="Name"
        value={name}
        onChange={onName}
        error={errors.name}
        announceError
      >
        {(field) => (
          <Input
            {...field}
            data-field-name="name"
            onChange={(e) => field.onChange(e.target.value)}
            placeholder="Tonebox"
            autoComplete="off"
          />
        )}
      </FormField>
      <FormField
        name="slug"
        label="Slug"
        labelAside={
          <span className="text-xs text-fg-subtle">
            Permanent · used in keys and URLs
          </span>
        }
        help={
          available && !errors.slug ? (
            <span className="inline-flex items-center gap-1">
              <Check aria-hidden className="size-3.5" />
              Available
            </span>
          ) : checking && !errors.slug ? (
            "Checking…"
          ) : undefined
        }
        value={slug}
        onChange={onSlug}
        error={errors.slug}
        announceError
      >
        {(field) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...field}
              data-field-name="slug"
              onChange={(e) => field.onChange(e.target.value)}
              placeholder="tonebox"
              autoComplete="off"
              spellCheck={false}
              mono
              className="min-w-0 flex-1"
            />
            {suggestion ? (
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => onUseSuggestion(suggestion)}
              >
                Use {suggestion}
              </Button>
            ) : null}
          </div>
        )}
      </FormField>
    </FormStep>
  );
}

// ── What it's for ────────────────────────────────────────────────────────────────────────────

const summaryOf = (id: FeatureId): string => {
  const f = FEATURES.find((x) => x.id === id)!;
  return SERVICE_TABLE.find((s) => s.slug === f.primary[0])?.summary ?? "";
};

/** "What is it for?": the features (the Services page's), the Free tier and the platforms. */
export function PurposeStep({
  draft,
  onChange,
}: {
  draft: ProductDraft;
  onChange: (patch: Partial<ProductDraft>) => void;
}): React.ReactElement {
  const toggle = (id: FeatureId, on: boolean) =>
    onChange({
      features: on
        ? [...draft.features, id]
        : draft.features.filter((f) => f !== id),
    });
  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="sr-only">What it is for</legend>
        {FEATURES.map((f) => {
          const on = draft.features.includes(f.id);
          return (
            <div key={f.id} className="space-y-2">
              <Checkbox
                label={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {f.label}
                    {RECOMMENDED.includes(f.id) ? (
                      <StatusPill tone="info" size="sm">
                        Recommended
                      </StatusPill>
                    ) : null}
                  </span>
                }
                description={summaryOf(f.id)}
                checked={on}
                onCheckedChange={(c) => toggle(f.id, c)}
              />
              {f.id === "licensing" && on ? (
                <div className="ml-7">
                  <Switch
                    label="Start with a free tier"
                    checked={draft.freeTier}
                    onCheckedChange={(c) => onChange({ freeTier: c })}
                  />
                </div>
              ) : null}
              {f.id === "ship-builds" && on ? (
                <div className="ml-7 space-y-2">
                  <p className="text-sm text-fg-muted" id="np-platforms">
                    What does it ship? Storefronts follow these.
                  </p>
                  <div
                    role="group"
                    aria-labelledby="np-platforms"
                    className="flex flex-wrap gap-2"
                  >
                    {RELEASE_PLATFORMS.map((p) => {
                      const sel = draft.platforms.includes(p);
                      return (
                        <Button
                          key={p}
                          type="button"
                          size="sm"
                          variant={sel ? "secondary" : "outline"}
                          aria-pressed={sel}
                          iconStart={sel ? <Check aria-hidden /> : undefined}
                          onClick={() =>
                            onChange({
                              platforms: sel
                                ? draft.platforms.filter((x) => x !== p)
                                : [...draft.platforms, p],
                            })
                          }
                        >
                          {p}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <AutoList
        title="Polaris Key will set this up"
        items={planFor(draft).map((label, i) => ({
          id: `p${i}`,
          label,
          state: "will" as const,
        }))}
      />
    </div>
  );
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────

/**
 * A refusal no single field owns: a manifest the server would not accept, GitHub access, service
 * settings that don't fit together. Every problem is listed, so they can be fixed in one commit.
 */
export function RefusalCallout({
  copy,
  onCheckAgain,
}: {
  copy: ErrorCopy;
  onCheckAgain: () => void;
}): React.ReactElement {
  const lines = copy.problems?.length
    ? copy.problems.map((p) => ({
        key: `${p.file}${p.path}${p.message}`,
        text: (
          <>
            <span className="font-mono text-xs">
              {p.file}
              {p.path ? ` ${p.path}` : ""}
            </span>
            {": "}
            {p.message}
          </>
        ),
      }))
    : [...(copy.fieldErrors ?? []), ...(copy.lines ?? [])].map((l) => ({
        key: l,
        text: <>{l}</>,
      }));
  return (
    <Callout tone="danger" title={copy.title} live>
      <p>{copy.description}</p>
      {lines.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {lines.map((l) => (
            <li key={l.key}>{l.text}</li>
          ))}
        </ul>
      ) : null}
      {copy.fix ? (
        <div className="mt-3">
          <RefusalFix fix={copy.fix} onCheckAgain={onCheckAgain} />
        </div>
      ) : null}
    </Callout>
  );
}

/**
 * The fix a refusal offers beside its words (EXPERIENCE.md §0.3 "Inline fixes on errors"): the
 * GitHub App install guide, or "Check again" once a fixed manifest is pushed.
 */
export function RefusalFix({
  fix,
  onCheckAgain,
}: {
  fix: ErrorFix;
  onCheckAgain: () => void;
}): React.ReactElement {
  if (fix.kind === "check-again")
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onCheckAgain}
      >
        {fix.label}
      </Button>
    );
  return (
    <a
      href={DOCS_LINKS.createProduct}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
    >
      {fix.label}
      <ArrowRight aria-hidden className="size-3.5" />
    </a>
  );
}
