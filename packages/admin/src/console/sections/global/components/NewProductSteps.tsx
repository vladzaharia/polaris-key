import * as React from "react";
import { ArrowRight, Check, Circle, Lock } from "lucide-react";
import { RELEASE_PLATFORMS } from "@polaris-key/manifest";
import { DOCS_LINKS } from "../../../../lib/docsLinks.js";
import type { ErrorCopy, ErrorFix } from "../../../../lib/errorCopy.js";
import { cn } from "../../../../lib/cn.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { ServiceGlyph } from "../../../../ui/ServiceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Switch } from "../../../../ui/Switch.js";
import { FormStep } from "../../../../ui/wizard/index.js";
import { FEATURES, type FeatureId } from "../../../../services.generated.js";
import {
  RECOMMENDED,
  featureCopy,
  featureLabel,
  needsOf,
  platformLabel,
  unlocked,
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
  checkFailed,
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
  /** The slug check could not be asked: the server decides on Create. */
  checkFailed: boolean;
  onUseSuggestion: (slug: string) => void;
}): React.ReactElement {
  const hint =
    errors.slug || available || checking
      ? null
      : checkFailed
        ? "Could not check the slug. The server checks it when you create."
        : name.trim() !== "" && slug.trim() === ""
          ? "Type a slug: lowercase letters, digits and hyphens."
          : null;
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
          ) : (
            (hint ?? undefined)
          )
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

/** A feature the person can turn on: a card with its service's accent edge and one line of why. */
function FeatureCard({
  id,
  name,
  chosen,
  onToggle,
}: {
  id: FeatureId;
  name: string;
  chosen: readonly FeatureId[];
  onToggle: (id: FeatureId, on: boolean) => void;
}): React.ReactElement {
  const f = FEATURES.find((x) => x.id === id)!;
  const on = chosen.includes(id);
  const open = unlocked(id, chosen);
  const needs = needsOf(id);
  const descId = `np-feature-${id}-desc`;
  const titleId = `np-feature-${id}-title`;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-disabled={!open || undefined}
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-service={f.primary[0]}
      onClick={() => {
        if (open) onToggle(id, !on);
      }}
      className={cn(
        "pk-pressable flex min-w-0 flex-col items-start gap-1.5 rounded-lg border-2 p-3 text-left",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
        on
          ? "border-accent bg-accent-subtle"
          : "border-border bg-surface-raised hover:border-border-strong",
        !open && "cursor-not-allowed opacity-70",
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-sm font-medium text-fg-strong">
        <ServiceGlyph id={f.primary[0]!} />
        <span id={titleId} className="min-w-[6ch] flex-1 break-words">
          {f.label}
        </span>
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-sm border",
            on
              ? "border-accent bg-accent text-accent-on"
              : "border-border-strong bg-surface-sunken",
          )}
        >
          {on ? <Check className="size-3" /> : null}
          {!open ? <Lock className="size-3 text-fg-muted" /> : null}
        </span>
      </span>
      {RECOMMENDED.includes(id) && open ? (
        <StatusPill tone="info" size="sm">
          Recommended
        </StatusPill>
      ) : null}
      <span id={descId} className="text-xs text-fg-muted">
        {featureCopy(id, name)}
        {needs.length > 0 ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {needs.map((n) => (
              <span key={n} className="inline-flex items-center gap-1">
                Needs
                {chosen.includes(n) ? (
                  <Check aria-label="chosen" className="size-3 text-success" />
                ) : (
                  <Circle aria-label="not chosen" className="size-3" />
                )}
                {featureLabel(n)}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** "What is it for?": the features, the Free tier (when License is on) and the platforms. */
export function PurposeStep({
  draft,
  onToggle,
  onChange,
  notice,
}: {
  draft: ProductDraft;
  onToggle: (id: FeatureId, on: boolean) => void;
  onChange: (patch: Partial<ProductDraft>) => void;
  /** What a change turned off with it ("Commerce is off too: it needs Licensing."). */
  notice: string | null;
}): React.ReactElement {
  const name = draft.name.trim();
  const licensing = draft.features.includes("licensing");
  const ships = draft.features.includes("ship-builds");
  return (
    <div className="space-y-5">
      <fieldset className="space-y-3">
        <legend className="sr-only">Features</legend>
        <div className="@container">
          <div className="grid gap-2 @lg:grid-cols-2">
            {FEATURES.map((f) => (
              <FeatureCard
                key={f.id}
                id={f.id}
                name={name}
                chosen={draft.features}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
        <p role="status" className="min-h-0 text-sm text-fg-muted">
          {notice}
        </p>
      </fieldset>
      {licensing ? (
        <Switch
          touch
          className="justify-start gap-4"
          label="Start with a Free tier"
          description="Lifetime, 5 devices."
          checked={draft.freeTier}
          onCheckedChange={(c) => onChange({ freeTier: c })}
        />
      ) : null}
      {ships ? (
        <div className="space-y-2">
          <p className="text-sm text-fg" id="np-platforms">
            Where will {name || "it"} run?
          </p>
          <div
            role="group"
            aria-labelledby="np-platforms"
            className="flex flex-wrap gap-2"
          >
            {RELEASE_PLATFORMS.map((p) => {
              const sel = draft.platforms.includes(p);
              return (
                <button
                  key={p}
                  type="button"
                  role="checkbox"
                  aria-checked={sel}
                  onClick={() =>
                    onChange({
                      platforms: sel
                        ? draft.platforms.filter((x) => x !== p)
                        : [...draft.platforms, p],
                    })
                  }
                  className={cn(
                    "pk-pressable inline-flex min-h-9 items-center gap-1.5 rounded-md border-2 px-3 text-sm",
                    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
                    sel
                      ? "border-accent bg-accent-subtle text-fg-strong"
                      : "border-border bg-surface-raised text-fg hover:border-border-strong",
                  )}
                >
                  {sel ? <Check aria-hidden className="size-3.5" /> : null}
                  {platformLabel(p)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Creates ──────────────────────────────────────────────────────────────────────────────────

/** The rail (from 1024 px): what Create writes, as plain rows. */
export function CreatesRail({
  lines,
  name,
}: {
  lines: readonly string[];
  name: string;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-fg-strong">Creates</h3>
      {name ? <p className="break-words text-fg-muted">{name}</p> : null}
      <ul className="space-y-1">
        {lines.map((l) => (
          <li key={l} className="flex items-start gap-2">
            <Check
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-fg-muted"
            />
            <span className="min-w-0 break-words">{l}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The same list under 1024 px, collapsed to one line. */
export function CreatesBar({
  lines,
  summary,
}: {
  lines: readonly string[];
  summary: string;
}): React.ReactElement {
  return (
    <details className="rounded-lg border border-border bg-surface-sunken px-3 py-2 text-sm @4xl:hidden">
      <summary className="cursor-pointer text-fg">
        <span className="font-semibold text-fg-strong">Creates</span>
        {summary ? ` · ${summary}` : ""}
      </summary>
      <ul className="mt-2 space-y-1">
        {lines.map((l) => (
          <li key={l} className="flex items-start gap-2">
            <Check
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-fg-muted"
            />
            <span className="min-w-0 break-words">{l}</span>
          </li>
        ))}
      </ul>
    </details>
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
  installUrl,
}: {
  copy: ErrorCopy;
  onCheckAgain: () => void;
  installUrl?: string | null;
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
          <RefusalFix
            fix={copy.fix}
            onCheckAgain={onCheckAgain}
            installUrl={installUrl}
          />
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
  installUrl,
}: {
  fix: ErrorFix;
  onCheckAgain: () => void;
  installUrl?: string | null;
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
      href={installUrl ?? DOCS_LINKS.createProduct}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
    >
      {fix.label}
      <ArrowRight aria-hidden className="size-3.5" />
    </a>
  );
}
