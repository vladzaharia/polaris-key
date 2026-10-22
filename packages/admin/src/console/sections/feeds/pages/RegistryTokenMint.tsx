/**
 * Mint a token (F-33b.4): the dialog and the shown-once setup. On the product's page a read token
 * is a service token (`pkeyci_`, product-wide, Keys area); a publish token stays owner-bound; the
 * licence page mints licence-bound tokens.
 */

import * as React from "react";
import { KeyRound, Upload } from "lucide-react";
import {
  ApiError,
  type FeedEcosystem,
  type RegistryTokensDto,
} from "../../../../api.js";
import { errorCopy } from "../../../../lib/errorCopy.js";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { Checkbox } from "../../../../ui/Checkbox.js";
import { CodeBlock } from "../../../../ui/CodeBlock.js";
import { Dialog, DialogBody, DialogFooter } from "../../../../ui/Dialog.js";
import { FormField } from "../../../../ui/form.js";
import { Input } from "../../../../ui/Input.js";
import { NumberInput } from "../../../../ui/NumberInput.js";
import { RadioCards } from "../../../../ui/RadioCards.js";
import { Switch } from "../../../../ui/Switch.js";
import { mutate } from "../../../data/mutations.js";
import { useWriteGate } from "../../../access/useCan.js";
import { PACKAGE_ECOSYSTEM_RULES } from "@polaris-key/manifest";
import { serviceRow, type MintedRow } from "./registryTokenRows.js";
import {
  ECOSYSTEMS,
  ECOSYSTEM_ICONS,
  ECOSYSTEM_LABELS,
  feedSetupSnippets,
  type FeedScope,
} from "../model/model.js";

/** The environment variable CI keeps the token in (the name the docs and `pkey feeds setup` use). */
export const TOKEN_ENV = "PKEY_REGISTRY_TOKEN";

/** Does this ecosystem's setup need the feed's namespace (an npm scope, Maven prefixes…)? */
function needsNamespace(eco: FeedEcosystem): boolean {
  return Object.keys(PACKAGE_ECOSYSTEM_RULES[eco].namespace.fields).length > 0;
}

/**
 * The setup for the feeds the new token reaches. A service token is for CI: the command that
 * prints each client's setup, then the snippets for the private feeds only, reading
 * `${PKEY_REGISTRY_TOKEN}` rather than carrying the secret. Other tokens carry their value.
 */
export function MintedSnippets({
  data,
  minted,
}: {
  data: RegistryTokensDto;
  minted: MintedRow;
}): React.ReactElement {
  const service = minted.view.tokenId.startsWith("cit_");
  const reach = minted.view.ecosystems;
  const feeds = data.feeds.filter(
    (f) =>
      f.enabled &&
      f.baseUrl !== null &&
      (reach === null || reach.includes(f.ecosystem)) &&
      // A public feed needs no token, and a service token is never a Godot editor URL.
      (!service || (f.accessMode !== "public" && f.ecosystem !== "godot")),
  );
  if (feeds.length === 0)
    return (
      <Callout
        tone="info"
        title={
          service ? "No private feed to set up yet" : "No enabled feed yet"
        }
      >
        {service
          ? "Every enabled feed is public, so nothing needs this token yet. It works once a feed turns private."
          : "The token works once a feed it reaches is enabled."}
      </Callout>
    );
  const credential = (f: RegistryTokensDto["feeds"][number]) =>
    service
      ? ({ kind: "env", name: TOKEN_ENV } as const)
      : minted.view.presentation === "url"
        ? ({ kind: "godot-url", value: minted.token } as const)
        : ({ kind: "token", value: minted.token } as const);
  return (
    <div className="space-y-4">
      {service ? (
        <div className="space-y-1">
          <p className="text-xs text-fg-muted">
            Print each client's setup in CI, or on your machine:
          </p>
          <CodeBlock
            code={feeds
              .map(
                (f) =>
                  `pkey feeds setup --ecosystem ${f.ecosystem} --owner ${data.owner} --token-env ${TOKEN_ENV}`,
              )
              .join("\n")}
            language="sh"
            copy
          />
        </div>
      ) : null}
      {feeds.map((f) => {
        const Icon = ECOSYSTEM_ICONS[f.ecosystem];
        const namespace = f.namespace ?? {};
        const missing =
          needsNamespace(f.ecosystem) && Object.keys(namespace).length === 0;
        // The shared renderer (`renderFeedSetup`, the same bytes `pkey feeds setup` prints).
        const snippets = missing
          ? []
          : (feedSetupSnippets(
              f.ecosystem,
              { origin: f.baseUrl!, owner: data.owner, namespace },
              credential(f),
            ) ?? []);
        return (
          <section key={f.ecosystem} className="space-y-2">
            <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-fg-strong">
              <Icon aria-hidden className="size-4 text-fg-muted" />
              {f.label}
            </h3>
            {missing ? (
              <p className="text-xs text-fg-muted">
                Set this feed's namespace in its settings first: the setup names
                it.
              </p>
            ) : null}
            {snippets.map((s) => (
              <div key={s.id} className="space-y-1">
                <p className="text-xs text-fg-muted">{s.title}</p>
                {s.warning ? (
                  <Callout tone="warning">{s.warning}</Callout>
                ) : null}
                <CodeBlock
                  code={s.code}
                  language={s.language}
                  filename={s.filename}
                  copy
                />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

export function MintDialog({
  scope,
  data,
  licenseId,
  open,
  onOpenChange,
  onMinted,
}: {
  scope: FeedScope;
  data: RegistryTokensDto;
  /** Fixed binding: the licence page mints for its licence only. */
  licenseId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMinted: (m: MintedRow) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [everyFeed, setEveryFeed] = React.useState(true);
  const [picked, setPicked] = React.useState<FeedEcosystem[]>([]);
  const [godotUrl, setGodotUrl] = React.useState(false);
  // A publish token (native clients: npm publish, twine, SwiftPM, Maven/Gradle, docker push).
  const [access, setAccess] = React.useState<"read" | "publish">("read");
  const [days, setDays] = React.useState<number | null>(
    data.limits.defaultDays,
  );
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  // Errors show once the operator has typed in a field or tried to create.
  const [attempted, setAttempted] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);
  React.useEffect(() => {
    if (!open) return;
    setAttempted(false);
    setLabel("");
    setEveryFeed(true);
    setPicked([]);
    setGodotUrl(false);
    setAccess("read");
    setDays(data.limits.defaultDays);
    setFailure(null);
  }, [open, data.limits.defaultDays, licenseId]);
  const publishEcosystems: readonly FeedEcosystem[] = React.useMemo(
    () => data.limits.publishEcosystems ?? [],
    [data.limits.publishEcosystems],
  ); // Never on the platform scope: the SDK feeds are published by the deploy pipeline only (F-10).
  const canPublish =
    scope.kind === "product" &&
    licenseId === undefined &&
    publishEcosystems.length > 0;
  // Minting a service token needs the Keys area, like CI tokens (F-33b.3): without it the only
  // way in is a publish token, if the product has any publish feed.
  const keys = useWriteGate(
    "keys",
    scope.kind === "product" ? scope.slug : null,
  );
  const noKeys = licenseId === undefined && !keys.allowed;
  const publish = access === "publish" || (noKeys && canPublish);
  // On the product's page a read token is a service token (`pkeyci_`, product-wide); the licence
  // page mints licence-bound `pkeyr_` tokens, and a publish token stays owner-bound (F-33b.3).
  const service = licenseId === undefined && !publish;
  const binding = licenseId === undefined ? "owner" : "license";

  React.useEffect(() => {
    setDays(
      publish
        ? (data.limits.publishDefaultDays ?? data.limits.defaultDays)
        : service
          ? (data.limits.serviceDefaultDays ?? 90)
          : godotUrl
            ? data.limits.urlDefaultDays
            : data.limits.defaultDays,
    );
  }, [
    open,
    publish,
    service,
    godotUrl,
    data.limits.serviceDefaultDays,
    data.limits.urlDefaultDays,
    data.limits.defaultDays,
    data.limits.publishDefaultDays,
  ]);
  React.useEffect(() => {
    if (!publish) return;
    setGodotUrl(false);
    setEveryFeed(false);
    setPicked((p) => {
      const kept = p.filter((e) => publishEcosystems.includes(e));
      // A sole publish feed is the only choice: tick it.
      const next =
        kept.length === 0 && publishEcosystems.length === 1
          ? [...publishEcosystems]
          : kept;
      return next.length === p.length && next.every((e, i) => e === p[i])
        ? p
        : next;
    });
  }, [open, publish, publishEcosystems]);

  const minDays = data.limits.minDays;
  const maxDays = publish
    ? (data.limits.publishMaxDays ?? data.limits.maxDays)
    : service
      ? (data.limits.serviceMaxDays ?? 365)
      : data.limits.maxDays;
  const daysError =
    days === null || !Number.isInteger(days) || days < minDays || days > maxDays
      ? `Use a whole number of days from ${minDays} to ${maxDays}.`
      : undefined;
  const labelError =
    label.trim() === "" || label.trim().length > 64
      ? "Give the token a label of up to 64 characters."
      : // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f]/.test(label)
        ? "Remove control characters from the label."
        : undefined;
  const feedsError =
    !service && !godotUrl && (publish || !everyFeed) && picked.length === 0
      ? publish
        ? "Choose the feeds this token publishes to."
        : "Choose at least one feed."
      : undefined;
  const invalid = !!(daysError || labelError || feedsError);
  // What the server refused, by field (422), marked on the form instead of a bare banner.
  const refused = failure instanceof ApiError ? (failure.fields ?? []) : [];
  const limitHit =
    failure instanceof ApiError && failure.reason === "token_limit";

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    if (invalid) {
      setAttempted(true);
      // Focus the first field the errors mark, once they have rendered.
      window.setTimeout(
        () =>
          formRef.current
            ?.querySelector<HTMLElement>('[aria-invalid="true"]')
            ?.focus(),
        0,
      );
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      if (service) {
        const res = await mutate("mintServiceToken", scope, {
          label: label.trim(),
          binding: "service",
          expiresInDays: days!,
        });
        onMinted({ ok: true, token: res.token, view: serviceRow(res.view) });
        return;
      }
      const res = await mutate("mintRegistryToken", scope, {
        label: label.trim(),
        binding,
        ...(licenseId !== undefined ? { licenseId } : {}),
        expiresInDays: days!,
        ...(publish
          ? { scopes: ["publish" as const], ecosystems: picked }
          : godotUrl
            ? { presentation: "url" as const }
            : { ecosystems: everyFeed ? null : picked }),
      });
      onMinted(res);
    } catch (err) {
      setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o);
      }}
      dismissible={!saving}
      title={
        service
          ? "New service token"
          : publish
            ? "New publish token"
            : "New registry token"
      }
      description={
        service
          ? "For CI and servers that install from private feeds. Reads every private feed of this product."
          : licenseId !== undefined
            ? "Access to this license's feeds."
            : "Access to this product's feeds."
      }
    >
      <form ref={formRef} onSubmit={submit} noValidate>
        <DialogBody className="space-y-4">
          <FormField
            name="label"
            label="Label"
            required
            value={label}
            onChange={(v: string) => setLabel(v)}
            error={
              refused.includes("label")
                ? "The server refused this label. Change it and try again."
                : attempted || label !== ""
                  ? labelError
                  : undefined
            }
          >
            {(f) => <Input {...f} maxLength={64} />}
          </FormField>
          {canPublish ? (
            <FormField
              name="access"
              label="Access"
              group
              value={publish ? "publish" : "read"}
              onChange={(v: string) => setAccess(v as "read" | "publish")}
            >
              {(f) => (
                <RadioCards<string>
                  {...f}
                  columns={2}
                  options={[
                    {
                      value: "read",
                      label: "Read",
                      description: noKeys
                        ? keys.disabledReason
                        : "Service token: install from every private feed.",
                      disabled: noKeys,
                      icon: <KeyRound aria-hidden className="size-4" />,
                    },
                    {
                      value: "publish",
                      label: "Read and publish",
                      description: `npm publish, twine, SwiftPM, Maven or Gradle deploys and docker push. At most ${data.limits.publishMaxDays ?? maxDays} days; in CI use the job's OIDC token instead.`,
                      icon: <Upload aria-hidden className="size-4" />,
                    },
                  ]}
                />
              )}
            </FormField>
          ) : null}
          {!publish && !service ? (
            <Switch
              label="Godot editor URL"
              description="The editor sends no credentials, so this token goes in its URL: Godot feeds only, read only."
              checked={godotUrl}
              onCheckedChange={setGodotUrl}
            />
          ) : null}
          {!godotUrl && !service ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-fg-strong">
                Feeds
              </legend>
              {!publish ? (
                <Checkbox
                  label="Every feed"
                  description="Today's and any this product enables later."
                  checked={everyFeed}
                  onCheckedChange={setEveryFeed}
                />
              ) : null}
              {publish || !everyFeed ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {(publish ? publishEcosystems : ECOSYSTEMS).map((e) => {
                    const Icon = ECOSYSTEM_ICONS[e];
                    return (
                      <Checkbox
                        key={e}
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <Icon aria-hidden className="size-4" />
                            {ECOSYSTEM_LABELS[e]}
                          </span>
                        }
                        checked={picked.includes(e)}
                        onCheckedChange={(on) =>
                          setPicked(
                            on ? [...picked, e] : picked.filter((x) => x !== e),
                          )
                        }
                      />
                    );
                  })}
                </div>
              ) : null}
              {feedsError && attempted ? (
                <p className="text-xs text-danger" aria-live="polite">
                  {feedsError}
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <FormField
            name="expiresInDays"
            label="Expires after"
            className="w-44"
            required
            value={days}
            onChange={(v: number | null) => setDays(v)}
            error={
              refused.includes("expiresInDays")
                ? "The server refused this expiry. Change it and try again."
                : daysError
            }
          >
            {(f) => (
              <NumberInput
                {...f}
                integer
                nullable
                min={minDays}
                max={maxDays}
                unit="days"
              />
            )}
          </FormField>
          {limitHit ? (
            <Callout alert tone="danger" title="Too many active tokens">
              {licenseId !== undefined
                ? `This license has ${data.limits.perLicense} active tokens, the most it can have.`
                : `${data.owner} has ${data.limits.perOwner} active tokens, the most it can have.`}{" "}
              Revoke one, then try again.
            </Callout>
          ) : failure && refused.length === 0 ? (
            <Callout alert tone="danger" title={errorCopy(failure).title}>
              {errorCopy(failure).description}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Create token
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
