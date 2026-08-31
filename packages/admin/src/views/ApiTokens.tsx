import * as React from "react";
import { AlertTriangle, KeySquare, Plus, RefreshCw } from "lucide-react";
import {
  ApiError,
  MAX_TOKEN_DAYS,
  api,
  type AdminApiToken,
  type AdminApiTokenStatus,
} from "../api.js";
import { useResource } from "../context.js";
import { docsUrl } from "../lib/docsLinks.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogActionBar,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import { OneTimeKeyPanel, formatStamp } from "./licenses/shared.js";

/**
 * Admin API tokens — the PLATFORM's machine credential (`pkeya_…`), listed, minted and revoked.
 *
 * Platform-scoped like the product registry: a token belongs to the deployment, not to a
 * product, and the worker gates the whole surface on platform admin AND on the session cookie
 * (`admin/apiTokens.ts` names no scope for these routes, so a token cannot manage tokens).
 *
 * ── WHERE THE MINTED SECRET LIVES, AND WHY IT CANNOT LEAK INTO THIS VIEW ────────────────────
 *
 * The plaintext rides exactly one response — the mint's — and nothing stored server-side can
 * reproduce it. "Shown once" therefore has to be a fact about this component tree, not a promise
 * in the copy, so it is enforced by SHAPE rather than by discipline:
 *
 *  1. This component holds `mintOpen: boolean` and nothing else about the mint. The secret has
 *     no state slot here to be written into.
 *  2. `MintTokenDialog` is mounted ONLY while open. Closing it unmounts the component that owns
 *     the secret, so React drops it; there is no reset-on-open path where a stale value could
 *     survive. Navigating away unmounts the whole view for the same reason (`App` keys its
 *     content by route), so a back button cannot bring it back.
 *  3. The roster is refetched from the server after a mint — the mint response's `token` is
 *     never spliced into the list. `AdminApiToken` has no secret field, so the list state is
 *     structurally incapable of carrying one even if somebody tried.
 */
export function ApiTokens(): React.ReactElement {
  const toast = useToast();
  const { data, loading, error, reload } = useResource("apiTokens", () =>
    api.apiTokens(),
  );
  const tokens = data?.tokens ?? [];

  // The ONLY mint-related state this component holds. Deliberately not the secret — see above.
  const [mintOpen, setMintOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState<AdminApiToken | null>(null);
  const [busy, setBusy] = React.useState(false);

  const revoke = async (): Promise<void> => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeApiToken(revoking.id);
      toast.success("Token revoked", `“${revoking.label}” stops working now.`);
      setRevoking(null);
      reload();
    } catch (err) {
      toast.error(
        "Could not revoke token",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<AdminApiToken>[] = [
    {
      id: "label",
      header: "Label",
      accessor: (t) => t.label,
      sortable: true,
      cell: (t) => (
        <div className="flex flex-col">
          <span className="font-medium text-foreground">{t.label}</span>
          <code className="font-mono text-xs text-muted-foreground">
            {t.id}
          </code>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (t) => t.status,
      sortable: true,
      cell: (t) => <TokenStatusBadge status={t.status} />,
    },
    {
      id: "scopes",
      header: "Scopes",
      accessor: (t) => t.scopes.join(" "),
      cell: (t) =>
        t.scopes.length === 0 ? (
          // A row whose scope list would not parse grants NOTHING server-side; say so rather
          // than rendering an empty cell that reads like "unrestricted".
          <span className="text-muted-foreground">none — grants nothing</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {t.scopes.map((scope) => (
              <Badge key={scope} variant="outline">
                <span className="font-mono">{scope}</span>
              </Badge>
            ))}
          </span>
        ),
    },
    {
      id: "createdAt",
      header: "Created",
      accessor: (t) => t.createdAt,
      sortable: true,
      cell: (t) => (
        <span className="text-muted-foreground">
          {formatStamp(t.createdAt)}
        </span>
      ),
    },
    {
      id: "expiresAt",
      header: "Expires",
      accessor: (t) => t.expiresAt,
      sortable: true,
      cell: (t) => (
        <span className="text-muted-foreground">
          {formatStamp(t.expiresAt)}
        </span>
      ),
    },
    {
      id: "lastUsedAt",
      header: "Last used",
      accessor: (t) => t.lastUsedAt ?? 0,
      sortable: true,
      // "never" and not an em-dash: an unused machine credential is a finding, not missing data.
      cell: (t) =>
        t.lastUsedAt === null ? (
          <span className="text-muted-foreground">never</span>
        ) : (
          <span className="text-muted-foreground">
            {formatStamp(t.lastUsedAt)}
          </span>
        ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      headerClassName: "w-px",
      className: "w-px text-right",
      // An EXPIRED token is still revocable: the worker refuses only on `revoked_at IS NOT NULL`,
      // and an operator who no longer trusts a credential should not have to reason about
      // whether its clock already saved them.
      cell: (t) =>
        t.status === "revoked" ? null : (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Revoke ${t.label}`}
            onClick={() => setRevoking(t)}
          >
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">API tokens</h2>
          <p className="text-sm text-muted-foreground">
            Scoped, individually revocable credentials for non-browser callers
            such as <code className="font-mono">pkey bundle</code> in CI. A
            token cannot manage tokens — this screen needs your console session.{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("mintApiToken")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </p>
        </div>
        <Button onClick={() => setMintOpen(true)}>
          <Plus aria-hidden /> New token
        </Button>
      </header>

      {error ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load API tokens"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              <RefreshCw aria-hidden /> Retry
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={tokens}
          rowKey={(t) => t.id}
          loading={loading && tokens.length === 0}
          filterable
          filterPlaceholder="Filter tokens…"
          empty={
            <EmptyState
              icon={<KeySquare aria-hidden />}
              title="No API tokens"
              description="Mint one to let a build or a CI job call the admin API without an operator’s browser session."
              action={
                <Button onClick={() => setMintOpen(true)}>
                  <Plus aria-hidden /> New token
                </Button>
              }
            />
          }
        />
      )}

      {/* Mounted only while open: unmounting is what destroys the minted secret. */}
      {mintOpen ? (
        <MintTokenDialog onClose={() => setMintOpen(false)} onMinted={reload} />
      ) : null}

      <ConfirmDialog
        open={revoking != null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.label ?? ""}”?`}
        description="The token stops working on its next request. Anything using it — a CI job, a build script — starts failing immediately, and the secret cannot be recovered, so a replacement has to be minted. The row is kept so the history survives."
        confirmLabel="Revoke token"
        loading={busy}
        onConfirm={revoke}
      />
    </section>
  );
}

/** Active / expired / revoked, each visually distinct — the roster's whole triage value. */
function TokenStatusBadge({
  status,
}: {
  status: AdminApiTokenStatus;
}): React.ReactElement {
  const variant =
    status === "active"
      ? "success"
      : status === "expired"
        ? "warning"
        : "destructive";
  return <Badge variant={variant}>{status}</Badge>;
}

/** The per-field message for a name the server returned in a 422's `fields`. */
const FIELD_MESSAGES: Record<string, string> = {
  label: "Give the token a name, 200 characters or fewer.",
  expiresInDays: `Enter a whole number of days between 1 and ${MAX_TOKEN_DAYS}.`,
  scopes: "Pick at least one scope this build knows about.",
};

/**
 * Mint one token.
 *
 * THIS COMPONENT IS THE SECRET'S ONLY HOME. It is mounted while the dialog is open and unmounted
 * when it closes, so `secret` cannot outlive the dialog — there is no `open` prop and no
 * reset-on-open effect precisely so that "closed" and "does not exist" are the same state.
 *
 * `expiresInDays` has no default value in this form, mirroring the server's refusal to invent
 * one: a lifetime the operator did not choose is the failure mode the mandatory field exists to
 * prevent, and pre-filling the box would defeat it while looking helpful.
 */
function MintTokenDialog({
  onClose,
  onMinted,
}: {
  onClose: () => void;
  onMinted: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [label, setLabel] = React.useState("");
  const [days, setDays] = React.useState("");
  const [secret, setSecret] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [busy, setBusy] = React.useState(false);

  const mint = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const expiresInDays = Number(days.trim());
    // Pre-flight only the two things a round-trip cannot improve on. Everything else is the
    // server's answer, surfaced below against the field it names.
    const local: Record<string, string> = {};
    if (label.trim() === "") local.label = FIELD_MESSAGES.label!;
    if (
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > MAX_TOKEN_DAYS
    ) {
      local.expiresInDays = FIELD_MESSAGES.expiresInDays!;
    }
    setFieldErrors(local);
    if (Object.keys(local).length > 0) return;

    setBusy(true);
    try {
      const res = await api.mintApiToken({
        label: label.trim(),
        expiresInDays,
      });
      // Only `secret` is kept, and only here. `res.token` is deliberately discarded: the roster
      // is reloaded from the server instead, so no object that ever held the plaintext is
      // handed to the list.
      setSecret(res.secret);
      toast.success("Token minted", "Copy the secret before closing.");
      onMinted();
    } catch (err) {
      if (err instanceof ApiError && err.fields?.length) {
        setFieldErrors(
          Object.fromEntries(
            err.fields.map((f) => [f, FIELD_MESSAGES[f] ?? "Invalid value."]),
          ),
        );
      } else {
        toast.error(
          "Could not mint token",
          err instanceof Error ? err.message : undefined,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {secret ? "Copy this token now" : "New API token"}
          </DialogTitle>
          <DialogDescription>
            {secret
              ? "This is the only time the secret will ever be shown. Nothing stored can reproduce it — close this dialog without copying and the only way forward is to revoke and mint again."
              : "Issue a credential a build or CI job can present as an Authorization header."}{" "}
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={docsUrl("mintApiToken")}
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </a>
          </DialogDescription>
        </DialogHeader>

        {secret ? (
          <>
            <DialogBody>
              <div className="space-y-4">
                <OneTimeKeyPanel
                  value={secret}
                  title="API token minted"
                  description="Copy it now — it is shown only once and cannot be retrieved again. Store it as a secret in your CI provider, never in the repository."
                  valueLabel="Minted API token"
                  copyLabel="Copy token"
                />
              </div>
            </DialogBody>
            <DialogActionBar>
              {/* Closing is what forgets the secret — this component unmounts with it. */}
              <Button onClick={onClose}>Done</Button>
            </DialogActionBar>
          </>
        ) : (
          // `noValidate` for the same reason the Settings form carries it: the expiry input is
          // bounded, so letting the browser block submission would replace this dialog's
          // field-level message — the one that also has to carry the server's 422 — with a
          // native bubble that says something different in every browser.
          <form onSubmit={mint} className="contents" noValidate>
            <DialogBody>
              <div className="space-y-4">
                <Field
                  label="Label"
                  required
                  error={fieldErrors.label}
                  help="What this token is for. Shown in the roster and in every audit row it writes."
                >
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="CI bundle minter"
                    maxLength={200}
                    autoFocus
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="Expires in (days)"
                  required
                  error={fieldErrors.expiresInDays}
                  help={`Required, 1–${MAX_TOKEN_DAYS}. There is no default: a machine credential's lifetime is a decision, not a setting to leave alone.`}
                >
                  <Input
                    type="number"
                    min={1}
                    max={MAX_TOKEN_DAYS}
                    inputMode="numeric"
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    placeholder="90"
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Scope:{" "}
                  <Badge variant="outline">
                    <span className="font-mono">bundles:mint</span>
                  </Badge>{" "}
                  — the whole vocabulary today. Every other admin route refuses
                  a token by default.
                </p>
              </div>
            </DialogBody>
            <DialogActionBar>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Mint token
              </Button>
            </DialogActionBar>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
