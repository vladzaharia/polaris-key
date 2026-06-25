import * as React from "react";
import { CheckCircle2, Github, KeyRound, PlusCircle } from "lucide-react";
import {
  api,
  type CreateManualProductResult,
  type LinkRepoResult,
} from "../../api.js";
import { invalidate } from "../../context.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  useToast,
} from "../../components/ui/index.js";
import {
  errorMessage,
  intOrUndefined,
  parseSchemaField,
  signingBundleOf,
  slugError,
  trimmedOrUndefined,
} from "./util.js";

/** A copyable read-only key/value row used in the success panels. */
function ResultRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground break-all text-right">
        {value}
      </span>
    </div>
  );
}

/** The "record the public key" reminder shared by both creation flows. */
function KeyReminder({
  result,
}: {
  result: CreateManualProductResult | LinkRepoResult;
}): React.ReactElement {
  const bundle = signingBundleOf(result);
  const kid = bundle.kid ?? result.kid;
  const trustSet =
    Object.keys(bundle.trustKeys).length > 0
      ? JSON.stringify(bundle.trustKeys, null, 2)
      : null;
  return (
    <Card className="border-warning/40 bg-warning/5">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <KeyRound aria-hidden className="size-4 text-warning" />
          Record the trust key
        </div>
        <ResultRow label="Signing kid" value={kid} />
        {bundle.publicKey ? (
          <ResultRow label="Public key" value={bundle.publicKey} />
        ) : null}
        {bundle.jwksUrl ? (
          <ResultRow label="JWKS" value={bundle.jwksUrl} />
        ) : null}
        {trustSet ? (
          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Trust set</span>
            <pre className="max-h-36 overflow-auto rounded-md border border-border bg-background/70 p-3 text-xs font-mono whitespace-pre-wrap break-all">
              {trustSet}
            </pre>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Store this <code className="font-mono">kid</code>
          {bundle.publicKey ? " and public key" : ""} with your release tooling
          and SDK trust configuration now. The private key never leaves the
          platform.
        </p>
        {!bundle.publicKey && !trustSet ? (
          <p className="text-xs text-muted-foreground">
            This response did not include a public key yet. Use the product
            overview/JWKS once the backend exposes it, or rotate the key to
            retrieve fresh public key material.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ManualTab({ onDone }: { onDone: () => void }): React.ReactElement {
  const toast = useToast();
  const [slug, setSlug] = React.useState("");
  const [name, setName] = React.useState("");
  const [schema, setSchema] = React.useState("");
  const [compatMin, setCompatMin] = React.useState("");
  const [compatMax, setCompatMax] = React.useState("");
  const [maxOfflineDays, setMaxOfflineDays] = React.useState("");
  const [machineLimit, setMachineLimit] = React.useState("");
  const [adminGroup, setAdminGroup] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CreateManualProductResult | null>(
    null,
  );

  const slugErr = slug !== "" ? slugError(slug) : null;
  const schemaParsed = parseSchemaField(schema);

  const submit = async (): Promise<void> => {
    const se = slugError(slug);
    if (se) {
      setFormError(se);
      return;
    }
    if (schemaParsed.error) {
      setFormError(schemaParsed.error);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await api.createManualProduct({
        slug: slug.trim(),
        name: trimmedOrUndefined(name),
        schema: schemaParsed.value,
        compatMin: trimmedOrUndefined(compatMin),
        compatMax: trimmedOrUndefined(compatMax),
        defaultMaxOfflineDays: intOrUndefined(maxOfflineDays),
        defaultMachineLimit: intOrUndefined(machineLimit),
        adminGroup: trimmedOrUndefined(adminGroup),
      });
      invalidate("products");
      toast.success("Product created", `“${res.slug}” is registered.`);
      setResult(res);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 aria-hidden className="size-5" />
          Product “{result.slug}” registered
        </div>
        <KeyReminder result={result} />
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Slug"
          required
          error={slugErr ?? undefined}
          help="Lowercase id, e.g. djdl."
        >
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-product"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Product"
          />
        </Field>
      </div>

      <Field
        label="Catalog schema"
        help="Paste JSON or YAML for the product config catalog. Optional — publish later from Catalog."
        error={
          schema !== "" && schemaParsed.error ? schemaParsed.error : undefined
        }
      >
        <Textarea
          value={schema}
          onChange={(e) => setSchema(e.target.value)}
          rows={6}
          placeholder={'{\n  "schemaVersion": 2,\n  "entries": []\n}'}
          spellCheck={false}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Compat min" help="Lowest supported client version.">
          <Input
            value={compatMin}
            onChange={(e) => setCompatMin(e.target.value)}
            placeholder="1.0.0"
          />
        </Field>
        <Field label="Compat max" help="Highest supported client version.">
          <Input
            value={compatMax}
            onChange={(e) => setCompatMax(e.target.value)}
            placeholder="2.0.0"
          />
        </Field>
        <Field label="Default max offline days">
          <Input
            type="number"
            inputMode="numeric"
            value={maxOfflineDays}
            onChange={(e) => setMaxOfflineDays(e.target.value)}
            placeholder="14"
          />
        </Field>
        <Field label="Default machine limit">
          <Input
            type="number"
            inputMode="numeric"
            value={machineLimit}
            onChange={(e) => setMachineLimit(e.target.value)}
            placeholder="3"
          />
        </Field>
      </div>

      <Field
        label="Admin group"
        help="Optional OIDC group that administers this product."
      >
        <Input
          value={adminGroup}
          onChange={(e) => setAdminGroup(e.target.value)}
          placeholder="pkey-djdl-admins"
        />
      </Field>

      {formError ? (
        <p
          role="alert"
          className="whitespace-pre-line text-sm font-medium text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={busy} disabled={slug.trim() === ""}>
          Create product
        </Button>
      </div>
    </form>
  );
}

function GithubTab({ onDone }: { onDone: () => void }): React.ReactElement {
  const toast = useToast();
  const [repoUrl, setRepoUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<LinkRepoResult | null>(null);

  const submit = async (): Promise<void> => {
    const url = repoUrl.trim();
    if (url === "") {
      setFormError("A repository URL is required.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await api.linkRepo(url);
      invalidate("products");
      toast.success("Repository linked", `“${res.slug}” is registered.`);
      setResult(res);
    } catch (err) {
      // The manifest-validation path returns an aggregated, multi-field error — surface it whole.
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const remaining = result.remainingSecrets ?? [];
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 aria-hidden className="size-5" />
          Repository linked as “{result.slug}”
        </div>
        <Card>
          <CardContent className="space-y-2 p-4">
            <ResultRow label="Slug" value={result.slug} />
            <ResultRow label="Signing kid" value={result.kid} />
          </CardContent>
        </Card>
        <KeyReminder result={result} />
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            Install the GitHub App
          </p>
          <p className="text-sm text-muted-foreground">
            Install (or confirm) the Polaris Key GitHub App on the repository so
            release publishing and resync can authenticate, then provide the
            secrets below.
          </p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              Remaining secrets
            </p>
            <Badge variant={remaining.length ? "warning" : "success"}>
              {remaining.length ? `${remaining.length} to set` : "all set"}
            </Badge>
          </div>
          {remaining.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No secrets are outstanding.
            </p>
          ) : (
            <ul className="space-y-1">
              {remaining.map((secret) => (
                <li key={secret} className="flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-warning"
                  />
                  <code className="font-mono">{secret}</code>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Set each secret from the product&apos;s Settings — values are
            write-only and never read back.
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field
        label="Repository URL"
        required
        help="The Polaris Key GitHub App reads the product manifest from the repo."
        error={formError && repoUrl.trim() === "" ? formError : undefined}
      >
        <Input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/acme/my-product"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      {formError && repoUrl.trim() !== "" ? (
        <p
          role="alert"
          className="whitespace-pre-line text-sm font-medium text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="submit" loading={busy} disabled={repoUrl.trim() === ""}>
          Link repository
        </Button>
      </div>
    </form>
  );
}

/**
 * The product-creation modal. Two tabs — a manual registration form and a GitHub link-repo
 * flow — each ending in a success panel that surfaces the new `kid` plus the operator
 * follow-ups (record the public key; set the remaining secrets). Closing resets via remount.
 */
export function CreateProductDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New product</DialogTitle>
          <DialogDescription>
            Register a product manually or link a GitHub repository the platform
            App can read.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="manual">
          <TabsList className="w-full">
            <TabsTrigger value="manual" className="flex-1 gap-2">
              <PlusCircle aria-hidden className="size-4" /> Manual
            </TabsTrigger>
            <TabsTrigger value="github" className="flex-1 gap-2">
              <Github aria-hidden className="size-4" /> From GitHub
            </TabsTrigger>
          </TabsList>
          <TabsContent value="manual">
            <ManualTab onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="github">
            <GithubTab onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
