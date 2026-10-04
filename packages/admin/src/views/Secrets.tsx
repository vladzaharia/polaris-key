import * as React from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { SecretUsage } from "../api.js";
import { OutletCredentials } from "./OutletCredentials.js";
import { useResource } from "../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useToast,
} from "../components/ui/index.js";
import { qk } from "../console/data/queries.js";
import { fetchProduct } from "../console/data/hooks.js";
import { mutate } from "../console/data/mutations.js";

/**
 * Product secrets. A write-only surface for sealed product secrets (OIDC client secrets,
 * edge-mint key material, provisioned secret values). `putProductSecret` stores values
 * encrypted under the platform KEK; they are never read back. The required-secret list comes
 * from the product's setup projection so operators can see what the manifest still expects.
 *
 * P0-12: a secret's USAGE is chosen here and only here — a manifest can name a secret in an
 * edge-mint recipe but can never make it signable. "Keep current" sends no usage, so
 * re-uploading a rotated key never silently changes what it may sign (a new secret is general).
 *
 * P5-01: store credentials are NOT product secrets. They have their own card below
 * (`OutletCredentials`), their own table and their own AAD kind, so edge-mint can never reach one.
 */

export type UsageChoice = "keep" | SecretUsage;

export const USAGE_CHOICES: { value: UsageChoice; label: string }[] = [
  { value: "keep", label: "Keep current (new secrets: general)" },
  { value: "general", label: "General" },
  { value: "edge-mint", label: "Edge-mint signing key" },
];
export function Secrets({ slug }: { slug: string }): React.ReactElement {
  const { data, loading, error, reload } = useResource(qk.product(slug), () =>
    fetchProduct(slug),
  );
  const toast = useToast();
  const [name, setName] = React.useState("");
  const [value, setValue] = React.useState("");
  const [usage, setUsage] = React.useState<UsageChoice>("keep");
  const [saving, setSaving] = React.useState(false);
  const [errors, setErrors] = React.useState<{ name?: string; value?: string }>(
    {},
  );

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const errs: { name?: string; value?: string } = {};
    if (!name.trim()) errs.name = "A secret name is required.";
    if (!value) errs.value = "A value is required.";
    setErrors(errs);
    if (errs.name || errs.value) return;
    setSaving(true);
    try {
      const secretName = name.trim();
      await mutate(
        "putProductSecret",
        slug,
        secretName,
        value,
        usage === "keep" ? undefined : usage,
      );
      toast.success(
        "Secret saved",
        `“${secretName}” was stored. Its value is never shown again.`,
      );
      setName("");
      setValue("");
      setUsage("keep");
    } catch (err) {
      toast.error(
        "Couldn’t save secret",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  const requiredSecrets = data?.setup?.secrets ?? [];
  return (
    <section aria-labelledby="secrets-title" className="space-y-6">
      <header className="space-y-1">
        <h2 id="secrets-title" className="text-xl font-semibold tracking-tight">
          Secrets
        </h2>
        <p className="text-sm text-muted-foreground">
          Write-only product secrets for{" "}
          <span className="font-medium text-foreground">{slug}</span>. Values
          are stored encrypted and never read back.
        </p>
      </header>

      {loading && !data ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      ) : error && !data ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load secrets"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={reload}>
              Retry
            </Button>
          }
        />
      ) : data ? (
        <Card>
          <form onSubmit={onSubmit} noValidate>
            <CardHeader>
              <CardTitle>Product secrets</CardTitle>
              <CardDescription>
                Set a write-only secret (e.g. an OIDC client secret or a minter
                key). Values are stored encrypted and never read back.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {requiredSecrets.length ? (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <p className="text-sm font-medium">Required secrets</p>
                  <div className="space-y-2">
                    {requiredSecrets.map((secret) => (
                      <div
                        key={secret.name}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <button
                            type="button"
                            className="break-all text-left font-mono text-xs text-accent-fg underline-offset-4 hover:underline"
                            onClick={() => setName(secret.name)}
                          >
                            {secret.name}
                          </button>
                          {secret.sources?.length ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {secret.sources.join(", ")}
                            </p>
                          ) : null}
                        </div>
                        <Badge
                          variant={secret.configured ? "success" : "warning"}
                        >
                          {secret.configured ? (
                            <CheckCircle2 aria-hidden className="size-3" />
                          ) : null}
                          {secret.configured ? "Configured" : "Missing"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Secret name" error={errors.name}>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. oidc_client_secret"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <Field label="Value" error={errors.value}>
                  <Input
                    type="password"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="secret-usage">Usage</Label>
                <Select
                  value={usage}
                  onValueChange={(next) => setUsage(next as UsageChoice)}
                >
                  <SelectTrigger
                    id="secret-usage"
                    aria-describedby="secret-usage-help"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {USAGE_CHOICES.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  id="secret-usage-help"
                  className="text-xs text-muted-foreground"
                >
                  Only a secret marked edge-mint can sign an edge-mint token; a
                  general secret (such as an OIDC client secret) never can.
                </p>
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" variant="secondary" loading={saving}>
                Set secret
              </Button>
            </CardFooter>
          </form>
        </Card>
      ) : null}
      {data ? <OutletCredentials slug={slug} /> : null}
    </section>
  );
}
