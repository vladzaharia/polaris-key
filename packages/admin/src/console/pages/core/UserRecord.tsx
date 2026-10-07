/**
 * A user of this product (I-12; S-16 §5.2): one pairwise subject, its licences, devices, data and
 * audit trail. Route tabs: Overview, Licenses, Devices, Activity, and Data while Cloud Sync is on
 * (reserved for U-11a).
 *
 * Never shown, because the server never sends it: the account id, the account's sign-in methods,
 * other products' licences, sessions or data, and personal details beyond the claims the person
 * consented to share with this product. A sign-in shows the method KIND used to reach this
 * product ("Steam"), never the account's link list.
 *
 * Actions: export (JSON), delete this product's data for the user (L3, typed), detach a licence
 * (L2), relink a licence to another user of this product (L2: a sign-in no older than five
 * minutes, a reason, notices to both accounts, 72-hour undo) and undo a relink (L1, same step-up
 * and reason). Nothing here disables, signs out, merges or deletes the account, or touches its
 * sign-in methods: those are never a developer's actions.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  api,
  ApiError,
  type ProductUserDetail,
  type ProductUserLicense,
  type ProductUserRelink,
} from "../../../api.js";
import { confirmFor } from "../../../lib/actions.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { formatBytes, fromSeconds } from "../../../lib/format.js";
import { PLATFORM_LABELS } from "../../../lib/labels.js";
import { Button } from "../../../ui/Button.js";
import { ConfirmDialog } from "../../../ui/ConfirmDialog.js";
import { DescriptionList } from "../../../ui/DescriptionList.js";
import { EmptyState } from "../../../ui/EmptyState.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { IdChip } from "../../../ui/IdChip.js";
import { PageSkeleton } from "../../../ui/Skeleton.js";
import { StatusPill } from "../../../ui/StatusPill.js";
import { Timestamp } from "../../../ui/Timestamp.js";
import { toast } from "../../../ui/toast.js";
import { Breadcrumbs } from "../../components/Breadcrumbs.js";
import { EntityLink } from "../../components/EntityLink.js";
import { PageHeader } from "../../components/PageHeader.js";
import { PageTabs } from "../../components/PageTabs.js";
import { useProduct } from "../../data/hooks.js";
import { mutate } from "../../data/mutations.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { navigate } from "../../router.js";
import { r } from "../../routes.js";
import { SettingsSection } from "../../templates/Settings.js";
import { RelinkDialog, UndoRelinkDialog } from "./UserRelink.js";
import { userSlots } from "./userSlots.js";

export const USER_TABS = [
  "overview",
  "licenses",
  "devices",
  "activity",
  "data",
] as const;
export type UserTab = (typeof USER_TABS)[number];

/** The tabs this product shows: `data` only while Cloud Sync is on and U-11a has filled it. */
export function visibleUserTabs(opts: { cloudSyncOn: boolean }): UserTab[] {
  return USER_TABS.filter(
    (t) => t !== "data" || (opts.cloudSyncOn && userSlots.dataTab !== null),
  );
}

/** A sign-in method KIND, as the row says it ("Signed in with Steam"). */
const SIGN_IN_KINDS: Record<string, string> = {
  oidc: "single sign-on",
  email: "email",
  magic: "an email link",
  google: "Google",
  apple: "Apple",
  steam: "Steam",
  passkey: "a passkey",
  gamecenter: "Game Center",
  pgs: "Play Games",
  eos: "Epic",
  key: "a license key",
};

export function signInKindLabel(kind: string): string {
  return SIGN_IN_KINDS[kind] ?? kind;
}

/** Save a JSON document as a file. False when the browser cannot. */
function downloadJson(filename: string, value: unknown): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

export function UserRecord({
  slug,
  subject,
  tab: rawTab,
}: {
  slug: string;
  subject: string;
  tab?: string;
}): React.ReactElement {
  const q = useQuery(
    {
      queryKey: qk.user(slug, subject),
      queryFn: () => api.productUser(slug, subject),
    },
    queryClient,
  );
  const mergedInto = q.data?.mergedInto;
  // D21: an absorbed subject resolves to the survivor's row, which lists it under "Merged from".
  React.useEffect(() => {
    if (mergedInto) navigate(r.user(slug, mergedInto), { replace: true });
  }, [mergedInto, slug]);

  const crumbs = (label: string) => (
    <Breadcrumbs items={[{ label: "Users", to: r.users(slug) }, { label }]} />
  );

  if (q.isPending || mergedInto) {
    return <PageSkeleton template="record" label="user" />;
  }
  const user = q.data?.user;
  if (!user) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={crumbs(subject)}
          title={notFound ? "User not found" : "User"}
        />
        {notFound ? (
          <EmptyState
            kind="not-found"
            title="This product has no such user"
            description="A user id belongs to one product. Check the link, or search the Users page."
            primaryAction={
              <Button variant="outline" onClick={() => navigate(r.users(slug))}>
                Back to users
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ thing: "User", collectionHref: r.users(slug) }}
          />
        )}
      </div>
    );
  }
  return (
    <UserRecordBody
      slug={slug}
      user={user}
      rawTab={rawTab}
      refetching={q.isFetching}
      crumbs={crumbs}
    />
  );
}

function UserRecordBody({
  slug,
  user,
  rawTab,
  refetching,
  crumbs,
}: {
  slug: string;
  user: ProductUserDetail;
  rawTab?: string;
  refetching: boolean;
  crumbs: (label: string) => React.ReactNode;
}): React.ReactElement {
  const product = useProduct(slug).data;
  const configOn = product?.services?.config?.enabled ?? false;
  // Cloud Sync is not a service yet (U-01); its Data tab (U-11a) appears once it is.
  const cloudSyncOn = userSlots.cloudSyncOn(product);
  const tabs = visibleUserTabs({ cloudSyncOn });
  const tab: UserTab = (tabs as string[]).includes(rawTab ?? "")
    ? (rawTab as UserTab)
    : "overview";
  const [dialog, setDialog] = React.useState<"delete" | null>(null);
  const [exporting, setExporting] = React.useState(false);

  const exportJson = async (): Promise<void> => {
    setExporting(true);
    try {
      const doc = await api.productUserExport(slug, user.subject);
      if (!downloadJson(`${slug}-${user.subject}.json`, doc))
        toast.error("Couldn't save the file");
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };

  const tabHref = (t: UserTab) =>
    r.user(slug, user.subject, t === "overview" ? undefined : t);
  const label: Record<UserTab, string> = {
    overview: "Overview",
    licenses: "Licenses",
    devices: "Devices",
    activity: "Activity",
    data: "Data",
  };
  const count: Partial<Record<UserTab, number>> = {
    licenses: user.licenses.length,
    devices: user.devices.length,
  };

  const DataTab = userSlots.dataTab;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={crumbs(user.subject)}
        title={<span className="font-mono">{user.subject}</span>}
        description={
          user.contact.email
            ? `${user.contact.email} · ${user.contact.source === "license" ? "from the license" : "shared by the user"}`
            : "No contact email shared with this product"
        }
        meta={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <IdChip value={user.subject} noun="user id" />
            <span>
              First seen <Timestamp at={fromSeconds(user.createdAt)} />
            </span>
          </span>
        }
        primaryAction={
          <Button
            variant="outline"
            iconStart={<Download aria-hidden />}
            loading={exporting}
            onClick={() => void exportJson()}
          >
            Export JSON
          </Button>
        }
        secondaryActions={[
          {
            label: "View in activity",
            onSelect: () => navigate(r.activity(slug, { q: user.subject })),
          },
        ]}
        dangerActions={[
          {
            label: "Delete data for this product…",
            onSelect: () => setDialog("delete"),
          },
        ]}
        refetching={refetching}
        tabs={
          <PageTabs
            label="User sections"
            value={tab}
            items={tabs.map((t) => ({
              value: t,
              label: label[t],
              to: tabHref(t),
              ...(count[t] !== undefined ? { count: count[t] } : {}),
            }))}
          />
        }
      />

      {tab === "overview" ? (
        <UserOverview slug={slug} user={user} configOn={configOn} />
      ) : null}
      {tab === "licenses" ? <UserLicenses slug={slug} user={user} /> : null}
      {tab === "devices" ? <UserDevices slug={slug} user={user} /> : null}
      {tab === "activity" ? <UserActivity user={user} /> : null}
      {tab === "data" && DataTab ? (
        <DataTab slug={slug} subject={user.subject} />
      ) : null}

      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent="danger"
        title="Delete this user's data for this product?"
        consequences={[
          "Every store of this product's data for this user is emptied: config overrides and Cloud Sync data.",
          "The user, their licenses and their Polaris Key account stay.",
          "This can't be undone. Export first if you need a copy.",
        ]}
        typedConfirmation={
          confirmFor("user.deleteData").typedConfirmation
            ? { value: "delete", label: "Type" }
            : undefined
        }
        confirmLabel="Delete data"
        describeError={(e) => errorCopy(e, { thing: "User" })}
        onConfirm={async () => {
          const res = await mutate("deleteProductUserData", slug, user.subject);
          toast.success(
            res.stores.length
              ? `Deleted data from ${res.stores.join(", ")}`
              : "There was no data to delete",
          );
        }}
      />
    </div>
  );
}

function UserOverview({
  slug,
  user,
  configOn,
}: {
  slug: string;
  user: ProductUserDetail;
  configOn: boolean;
}): React.ReactElement {
  const OverrideEditor = userSlots.overrideEditor;
  return (
    <div className="space-y-6">
      <SettingsSection id="user-summary" title="Summary">
        <div className="px-5 py-4">
          <DescriptionList
            columns={3}
            items={[
              {
                term: "Contact",
                detail: user.contact.email ?? (
                  <span className="text-fg-muted">None shared</span>
                ),
                help:
                  user.contact.source === "license"
                    ? "The buyer email on the license."
                    : user.contact.source === "consented"
                      ? "The user agreed to share their account email with this product."
                      : undefined,
              },
              {
                term: "Name",
                detail: user.name ?? (
                  <span className="text-fg-muted">None shared</span>
                ),
              },
              {
                term: "Data stored",
                detail: formatBytes(user.data.bytes),
                help: user.data.stores.length
                  ? user.data.stores
                      .map((s) => `${s.name} ${formatBytes(s.bytes)}`)
                      .join(" · ")
                  : undefined,
              },
            ]}
          />
        </div>
      </SettingsSection>

      {user.mergedFrom.length ? (
        <SettingsSection
          id="user-merged"
          title="Merged from"
          description="These ids belonged to this user before two of their accounts were merged. Each now opens this page."
        >
          <ul className="divide-y divide-border">
            {user.mergedFrom.map((m) => (
              <li
                key={m.subject}
                className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
              >
                <span className="font-mono text-xs">{m.subject}</span>
                <Timestamp at={fromSeconds(m.mergedAt)} />
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      {user.identityOn && user.signIns ? (
        <SettingsSection
          id="user-sign-ins"
          title="Sign-ins"
          description="How this user signed in to this product. Their other sign-in methods are theirs alone."
        >
          {user.signIns.length === 0 ? (
            <p className="px-5 py-4 text-sm text-fg-muted">
              No sign-ins to this product yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {user.signIns.map((s, i) => (
                <li
                  key={`${s.at}-${i}`}
                  className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
                >
                  <span>
                    {s.method
                      ? `Signed in with ${signInKindLabel(s.method)}`
                      : "Signed in"}
                  </span>
                  <Timestamp at={fromSeconds(s.at)} />
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      ) : null}

      {configOn && OverrideEditor ? (
        <OverrideEditor slug={slug} subject={user.subject} />
      ) : null}
    </div>
  );
}

function UserLicenses({
  slug,
  user,
}: {
  slug: string;
  user: ProductUserDetail;
}): React.ReactElement {
  const [detach, setDetach] = React.useState<ProductUserLicense | null>(null);
  const [relink, setRelink] = React.useState<ProductUserLicense | null>(null);
  const [undo, setUndo] = React.useState<ProductUserRelink | null>(null);

  return (
    <div className="space-y-6">
      <SettingsSection id="user-licenses" title="Licenses">
        {user.licenses.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">
            This user holds no license of this product.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {user.licenses.map((l) => (
              <li
                key={l.id}
                className="flex flex-col gap-3 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <EntityLink slug={slug} kind="license" id={l.id} />
                    {l.status !== "active" ? (
                      <StatusPill domain="license" state={l.status} />
                    ) : null}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {[l.name, l.email, l.tierId ? `tier ${l.tierId}` : null]
                      .filter(Boolean)
                      .join(" · ") || "No holder details"}
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-2">
                  <Button variant="outline" onClick={() => setRelink(l)}>
                    Relink…
                  </Button>
                  <Button variant="outline" onClick={() => setDetach(l)}>
                    Detach…
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {user.relinks.length ? (
        <SettingsSection
          id="user-relinks"
          title="Relinks"
          description="Licenses moved to or from this user. A relink can be undone for 72 hours while the license stays where it was moved."
        >
          <ul className="divide-y divide-border">
            {user.relinks.map((x) => (
              <li
                key={x.id}
                className="flex flex-col gap-3 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>
                    <EntityLink slug={slug} kind="license" id={x.licenseId} />{" "}
                    {x.kind === "floating" && x.direction === "out" ? (
                      // LX-30: Make floating from the licence record.
                      "made floating"
                    ) : x.kind === "reassign" && x.direction === "out" ? (
                      "reassigned to another email"
                    ) : (
                      <>
                        {x.direction === "in"
                          ? "moved here from "
                          : "moved to "}
                        <span className="font-mono text-xs">
                          {x.otherSubject ?? "a deleted account"}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {x.actorName ?? "An operator"} ·{" "}
                    <Timestamp at={fromSeconds(x.createdAt)} /> · “{x.reason}”
                    {x.undoneAt ? (
                      <>
                        {" "}
                        · undone <Timestamp at={fromSeconds(x.undoneAt)} />
                      </>
                    ) : null}
                  </span>
                </span>
                {x.undoable ? (
                  <span className="flex shrink-0 justify-end">
                    <Button variant="outline" onClick={() => setUndo(x)}>
                      Undo…
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      <ConfirmDialog
        open={detach !== null}
        onOpenChange={(o) => !o && setDetach(null)}
        intent="danger"
        title={`Detach ${detach?.name || detach?.id || "license"}?`}
        consequences={[
          "The license leaves this user's library and becomes unclaimed.",
          "Devices already activated keep working.",
          "Anyone who adds it by its key next can claim it, under the product's claim rules.",
        ]}
        confirmLabel="Detach license"
        describeError={(e) => errorCopy(e, { thing: "License" })}
        onConfirm={async () => {
          await mutate(
            "detachProductUserLicense",
            slug,
            user.subject,
            detach!.id,
          );
          toast.success("License detached");
        }}
      />
      <RelinkDialog
        slug={slug}
        subject={user.subject}
        license={relink}
        onClose={() => setRelink(null)}
      />
      <UndoRelinkDialog
        slug={slug}
        subject={user.subject}
        relink={undo}
        onClose={() => setUndo(null)}
      />
    </div>
  );
}

function UserDevices({
  slug,
  user,
}: {
  slug: string;
  user: ProductUserDetail;
}): React.ReactElement {
  if (user.devices.length === 0) {
    return (
      <EmptyState
        kind="first-run"
        title="No devices"
        description="This user has no device on a license of theirs, and has not signed in on one."
      />
    );
  }
  return (
    <SettingsSection id="user-devices" title="Devices">
      <ul className="divide-y divide-border">
        {user.devices.map((d) => (
          <li
            key={d.deviceId}
            className="flex flex-col gap-2 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <EntityLink slug={slug} kind="device" id={d.deviceId} />
                {d.status !== "authorized" ? (
                  <StatusPill domain="device" state={d.status} />
                ) : null}
              </span>
              <span className="text-xs text-fg-muted">
                {[
                  d.label,
                  d.platform
                    ? (PLATFORM_LABELS[d.platform] ?? d.platform)
                    : null,
                  d.appVersion,
                  user.identityOn && d.signedIn ? "signed in" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <span className="shrink-0 text-xs text-fg-muted">
              Last seen <Timestamp at={fromSeconds(d.lastSeen)} />
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}

function UserActivity({
  user,
}: {
  user: ProductUserDetail;
}): React.ReactElement {
  if (user.audit.length === 0) {
    return (
      <EmptyState
        kind="first-run"
        title="No activity"
        description="Console actions on this user and their licenses appear here."
      />
    );
  }
  return (
    <SettingsSection id="user-activity" title="Activity">
      <ul className="divide-y divide-border">
        {user.audit.map((a) => (
          <li
            key={a.id}
            className="flex flex-col gap-1 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-xs">{a.action}</span>
              <span className="truncate text-xs text-fg-muted">
                {[a.actorName, a.summary].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="shrink-0 text-xs text-fg-muted">
              <Timestamp at={fromSeconds(a.at)} />
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
