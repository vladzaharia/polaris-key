/**
 * Keys & secrets → CI publishing (docs/design/ADMIN.md §6.7): the trusted-publisher policy a
 * GitHub Actions run must match to publish, and static CI tokens for any other CI.
 *
 * - Editing the publisher claims it from the manifest (`source` becomes `admin`); resyncs then
 *   leave it alone. Claiming is the only way to grant `release:yank`.
 * - A static token is shown once (`OneTimeSecretDialog`); only its hash is stored. Revoke is L2.
 * - CI publishing lives here, but Release's guided first-release panel edits it too, through the
 *   same `PublisherDrawer` and `IssueCiTokenFlow` (EXPERIENCE.md §0.4 S2).
 */

import * as React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import {
  CI_SCOPES,
  api,
  type CiTokenDto,
  type IssuedCiToken,
  type PublisherClaimBody,
  type PublisherPolicyDto,
} from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { fromSeconds, toSeconds } from "../../../lib/format.js";
import { Button } from "../../../ui/Button.js";
import { Callout } from "../../../ui/Callout.js";
import { Checkbox } from "../../../ui/Checkbox.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DataTable, type DataColumn } from "../../../ui/data-table/index.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { Dialog, DialogBody, DialogFooter } from "../../../ui/Dialog.js";
import { Drawer, DrawerBody, DrawerFooter } from "../../../ui/Drawer.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { FormField } from "../../../ui/form.js";
import { Input } from "../../../ui/Input.js";
import { NumberInput } from "../../../ui/NumberInput.js";
import { OneTimeSecretDialog } from "../../../ui/OneTimeSecretPanel.js";
import { Skeleton } from "../../../ui/Skeleton.js";
import { SourceBadge } from "../../../ui/SourceBadge.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { SettingsRow, SettingsSection } from "../../templates/Settings.js";
import { intentOf } from "./confirmGate.js";

/** What each scope lets a CI run do, in the docs' words. */
const SCOPE_TEXT: Record<string, string> = {
  "release:publish": "Publish releases",
  "release:promote": "Promote releases on channels",
  "release:yank": "Yank releases",
  "distribution:report": "Report store status",
  "distribution:rollout": "Start and change rollouts",
  "distribution:feeds": "Publish package feeds",
  "distribution:listing": "Upload listing assets",
  "assets:write": "Upload hosted assets",
};

export function fetchCiPublisher(
  slug: string,
): Promise<PublisherPolicyDto | null> {
  return api.ciPublisher(slug).then((r) => r.policy);
}

export function fetchCiTokens(slug: string): Promise<CiTokenDto[]> {
  return api.ciTokens(slug).then((r) => r.tokens);
}

/** The trusted-publisher policy: one reader for this page and Release's guided panel. */
export function useCiPublisher(
  slug: string,
): UseQueryResult<PublisherPolicyDto | null> {
  return useQuery({
    queryKey: qk.ciPublisher(slug),
    queryFn: () => fetchCiPublisher(slug),
  });
}

/** The product's CI tokens: one reader for this page and Release's guided panel. */
export function useCiTokens(slug: string): UseQueryResult<CiTokenDto[]> {
  return useQuery({
    queryKey: qk.ciTokens(slug),
    queryFn: () => fetchCiTokens(slug),
  });
}

export function CiPublishingSection({
  slug,
}: {
  slug: string;
}): React.ReactElement {
  return (
    <SettingsSection id="keys-ci" title="CI publishing">
      <PublisherRow slug={slug} />
      <TokensRow slug={slug} />
    </SettingsSection>
  );
}

function ScopeList({ scopes }: { scopes: string[] }): React.ReactElement {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <StatusPill key={s} tone="neutral" icon={null} size="sm">
          {SCOPE_TEXT[s] ?? s}
        </StatusPill>
      ))}
    </span>
  );
}

function PublisherRow({ slug }: { slug: string }): React.ReactElement {
  const policy = useCiPublisher(slug);
  const [editing, setEditing] = React.useState(false);
  return (
    <SettingsRow
      label="Trusted publisher"
      align="block"
      help="A GitHub Actions run exchanges its OIDC token for a short-lived publishing token; no stored secret is involved."
      aside={
        policy.data ? (
          <Button
            variant="outline"
            size="sm"
            iconStart={<Pencil aria-hidden />}
            onClick={() => setEditing(true)}
          >
            Edit…
          </Button>
        ) : undefined
      }
      source={
        policy.data ? (
          <SourceBadge source={policy.data.source} path=".pkey/release" />
        ) : undefined
      }
    >
      {policy.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : policy.isError ? (
        <ErrorState
          compact
          error={policy.error}
          onRetry={() => void policy.refetch()}
        />
      ) : policy.data ? (
        <div className="space-y-3">
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Repository",
                detail: (
                  <span className="font-mono text-xs">
                    {policy.data.repository}
                  </span>
                ),
              },
              {
                term: "Workflow",
                detail: (
                  <span className="font-mono text-xs">
                    {policy.data.workflow}
                  </span>
                ),
              },
              { term: "Environment", detail: policy.data.environment },
              {
                term: "Scopes",
                detail: <ScopeList scopes={policy.data.scopes} />,
              },
            ]}
          />
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-fg-muted">
            No trusted publisher. A linked repository's manifest can declare
            one, or set it here.
          </p>
          <Button
            variant="outline"
            size="sm"
            iconStart={<Plus aria-hidden />}
            onClick={() => setEditing(true)}
          >
            Set trusted publisher…
          </Button>
        </div>
      )}
      <PublisherDrawer
        slug={slug}
        open={editing}
        policy={policy.data ?? null}
        onClose={() => setEditing(false)}
      />
    </SettingsRow>
  );
}

/**
 * Set or edit the trusted publisher. Keys & secrets → CI publishing and Release's guided panel
 * open this same drawer, so CI publishing is edited the same way from either place.
 */
export function PublisherDrawer({
  slug,
  open,
  policy,
  onClose,
}: {
  slug: string;
  open: boolean;
  policy: PublisherPolicyDto | null;
  onClose: () => void;
}): React.ReactElement {
  const [workflow, setWorkflow] = React.useState("");
  const [environment, setEnvironment] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [repository, setRepository] = React.useState("");
  const [repositoryId, setRepositoryId] = React.useState<number | null>(null);
  const [ownerId, setOwnerId] = React.useState<number | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);

  React.useEffect(() => {
    if (!open) return;
    setWorkflow(policy?.workflow ?? ".github/workflows/release.yml");
    setEnvironment(policy?.environment ?? "release");
    setScopes(
      policy?.scopes ?? [
        "distribution:report",
        "release:promote",
        "release:publish",
      ],
    );
    setRepository(policy?.repository ?? "");
    setRepositoryId(policy?.repositoryId ?? null);
    setOwnerId(policy?.repositoryOwnerId ?? null);
    setFailure(null);
  }, [open, policy]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFailure(null);
    const body: PublisherClaimBody = {
      workflow: workflow.trim(),
      environment: environment.trim(),
      scopes,
      ...(policy
        ? {}
        : {
            repository: repository.trim(),
            ...(repositoryId !== null ? { repositoryId } : {}),
            ...(ownerId !== null ? { repositoryOwnerId: ownerId } : {}),
          }),
    };
    try {
      await mutate("putCiPublisher", slug, body);
      toast.success("Trusted publisher saved");
      onClose();
    } catch (err) {
      setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
      dismissible={!saving}
      title={policy ? "Edit trusted publisher" : "Set trusted publisher"}
      description={
        policy?.source === "manifest"
          ? "Saving claims the policy from the manifest: resyncs stop changing it."
          : "Resyncs never change a publisher set here."
      }
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex min-h-0 flex-1 flex-col"
      >
        <DrawerBody className="space-y-4">
          {!policy ? (
            <>
              <FormField
                name="repository"
                label="Repository"
                required
                help="owner/repo, as GitHub spells it."
                value={repository}
                onChange={(v: string) => setRepository(v)}
              >
                {(f) => <Input {...f} mono />}
              </FormField>
              <FormField
                name="repositoryId"
                label="Repository id"
                required
                help="GitHub's numeric repository id: it survives a rename, the name does not."
                value={repositoryId}
                onChange={(v: number | null) => setRepositoryId(v)}
              >
                {(f) => <NumberInput {...f} integer nullable min={1} />}
              </FormField>
              <FormField
                name="repositoryOwnerId"
                label="Owner id"
                required
                help="GitHub's numeric id of the owning user or organization."
                value={ownerId}
                onChange={(v: number | null) => setOwnerId(v)}
              >
                {(f) => <NumberInput {...f} integer nullable min={1} />}
              </FormField>
            </>
          ) : null}
          <FormField
            name="workflow"
            label="Workflow"
            required
            help=".github/workflows/<file>.yml"
            value={workflow}
            onChange={(v: string) => setWorkflow(v)}
          >
            {(f) => <Input {...f} mono />}
          </FormField>
          <FormField
            name="environment"
            label="Environment"
            required
            help="The GitHub environment the job must run in."
            value={environment}
            onChange={(v: string) => setEnvironment(v)}
          >
            {(f) => <Input {...f} mono />}
          </FormField>
          <ScopePicker value={scopes} onChange={setScopes} />
          {failure ? (
            <Callout tone="danger" title={errorCopy(failure).title}>
              {errorCopy(failure).description}
            </Callout>
          ) : null}
        </DrawerBody>
        <DrawerFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={scopes.length === 0}>
            Save publisher
          </Button>
        </DrawerFooter>
      </form>
    </Drawer>
  );
}

function ScopePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-fg-strong">Scopes</legend>
      {CI_SCOPES.map((s) => (
        <Checkbox
          key={s}
          label={SCOPE_TEXT[s] ?? s}
          description={s}
          checked={value.includes(s)}
          onCheckedChange={(on) =>
            onChange(on ? [...value, s].sort() : value.filter((x) => x !== s))
          }
        />
      ))}
      {value.length === 0 ? (
        <p className="text-xs text-danger">Choose at least one scope.</p>
      ) : null}
    </fieldset>
  );
}

export function tokenState(
  t: CiTokenDto,
  nowSec: number,
): "active" | "expired" | "revoked" {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt <= nowSec) return "expired";
  return "active";
}

function TokensRow({ slug }: { slug: string }): React.ReactElement {
  const tokens = useCiTokens(slug);
  const [issuing, setIssuing] = React.useState(false);
  const [revoking, setRevoking] = React.useState<CiTokenDto | null>(null);
  const nowSec = toSeconds(Date.now());

  const columns = React.useMemo<DataColumn<CiTokenDto>[]>(
    () => [
      {
        id: "token",
        header: "Token",
        accessorFn: (t) => t.label ?? t.tokenId,
        meta: { priority: 1, primary: true },
        cell: ({ row }) => (
          <span className="inline-flex min-w-0 flex-col">
            <span className="truncate">
              {row.original.label ?? "Unlabelled"}
            </span>
            <span className="font-mono text-xs text-fg-muted">
              {row.original.tokenId}
            </span>
          </span>
        ),
      },
      {
        id: "kind",
        header: "Kind",
        accessorFn: (t) => (t.kind === "static" ? "Static" : "GitHub OIDC"),
        meta: { priority: 2 },
      },
      {
        id: "scopes",
        header: "Scopes",
        accessorFn: (t) => t.scopes.join(", "),
        meta: { priority: 3 },
        cell: ({ row }) => <ScopeList scopes={row.original.scopes} />,
      },
      {
        id: "state",
        header: "Status",
        accessorFn: (t) => tokenState(t, nowSec),
        meta: { priority: 1 },
        cell: ({ row }) => {
          const s = tokenState(row.original, nowSec);
          // Pills only for issues (EXPERIENCE.md §2): a working token is plain text.
          return s === "active" ? (
            <span className="text-sm text-fg">Active</span>
          ) : s === "expired" ? (
            <StatusPill tone="neutral">Expired</StatusPill>
          ) : (
            <StatusPill tone="neutral">Revoked</StatusPill>
          );
        },
      },
      {
        id: "expiresAt",
        header: "Expires",
        accessorKey: "expiresAt",
        meta: { numeric: true, priority: 2 },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.expiresAt)} />
        ),
      },
      {
        id: "issuedAt",
        header: "Issued",
        accessorKey: "issuedAt",
        meta: { numeric: true, priority: 3 },
        cell: ({ row }) => (
          <Timestamp at={fromSeconds(row.original.issuedAt)} />
        ),
      },
    ],
    [nowSec],
  );

  return (
    <SettingsRow
      label="CI tokens"
      help="For a CI that is not GitHub Actions. A static token lasts at most 90 days."
      footer={
        <div className="mt-4">
          <DataTable<CiTokenDto>
            id="ci-tokens"
            caption="CI tokens"
            data={tokens.data ?? []}
            columns={columns}
            getRowId={(t) => t.tokenId}
            rowLabel={(t) => t.label ?? t.tokenId}
            rowActions={(t) =>
              tokenState(t, nowSec) === "active"
                ? [
                    {
                      label: "Revoke…",
                      tone: "danger",
                      onSelect: () => setRevoking(t),
                    },
                  ]
                : []
            }
            loading={tokens.isPending}
            error={tokens.isError ? tokens.error : undefined}
            onRetry={() => void tokens.refetch()}
            exportCsv={false}
            mobile="cards"
            empty={
              <EmptyState
                kind="first-run"
                variant="inline"
                headingLevel={3}
                title="No CI tokens"
                description="Trusted publisher runs need none."
              />
            }
          />
        </div>
      }
    >
      <Button
        variant="outline"
        size="sm"
        iconStart={<Plus aria-hidden />}
        onClick={() => setIssuing(true)}
      >
        Issue token…
      </Button>
      <IssueCiTokenFlow slug={slug} open={issuing} onOpenChange={setIssuing} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        intent={intentOf("ciToken.revoke")}
        title={`Revoke ${revoking?.label ?? revoking?.tokenId ?? "token"}?`}
        consequences={[
          "CI runs using this token are refused from now on.",
          "Upload tickets it bought and has not used are revoked too.",
        ]}
        confirmLabel="Revoke token"
        describeError={(e) => errorCopy(e)}
        onConfirm={async () => {
          await mutate("revokeCiToken", slug, revoking!.tokenId);
          toast.success("CI token revoked");
        }}
      />
    </SettingsRow>
  );
}

/**
 * Issue a CI token, then show it once. Keys & secrets → CI publishing and Release's guided panel
 * open this same flow.
 */
export function IssueCiTokenFlow({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [issued, setIssued] = React.useState<IssuedCiToken | null>(null);
  return (
    <>
      <IssueTokenDialog
        slug={slug}
        open={open}
        onOpenChange={onOpenChange}
        onIssued={(t) => {
          onOpenChange(false);
          setIssued(t);
        }}
      />
      <OneTimeSecretDialog
        open={issued !== null}
        onOpenChange={(o) => {
          if (!o) setIssued(null);
        }}
        title="CI token issued"
        description={
          issued
            ? `Token ${issued.tokenId}. Store it in your CI's secret store now.`
            : undefined
        }
        label="CI token"
        value={issued?.token ?? ""}
        onDone={() => setIssued(null)}
      />
    </>
  );
}

function IssueTokenDialog({
  slug,
  open,
  onOpenChange,
  onIssued,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (t: IssuedCiToken) => void;
}): React.ReactElement {
  const [label, setLabel] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [days, setDays] = React.useState<number | null>(30);
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  React.useEffect(() => {
    if (open) {
      setLabel("");
      setScopes(["release:publish"]);
      setDays(30);
      setFailure(null);
    }
  }, [open]);
  const daysError =
    days === null || !Number.isInteger(days) || days < 1 || days > 90
      ? "Use a whole number of days from 1 to 90."
      : undefined;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving || daysError || scopes.length === 0) return;
    setSaving(true);
    setFailure(null);
    try {
      const res = await mutate("issueCiToken", slug, {
        scopes,
        expiresInDays: days!,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      onIssued(res);
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
      title="Issue a CI token"
    >
      <form onSubmit={submit} noValidate>
        <DialogBody className="space-y-4">
          <FormField
            name="label"
            label="Label"
            optional
            value={label}
            onChange={(v: string) => setLabel(v)}
          >
            {(f) => <Input {...f} maxLength={100} />}
          </FormField>
          <ScopePicker value={scopes} onChange={setScopes} />
          <FormField
            name="expiresInDays"
            label="Expires after"
            className="w-44"
            required
            value={days}
            onChange={(v: number | null) => setDays(v)}
            error={daysError}
          >
            {(f) => (
              <NumberInput
                {...f}
                integer
                nullable
                min={1}
                max={90}
                unit="days"
              />
            )}
          </FormField>
          {failure ? (
            <Callout tone="danger" title={errorCopy(failure).title}>
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
          <Button
            type="submit"
            loading={saving}
            disabled={!!daysError || scopes.length === 0}
          >
            Issue token
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
