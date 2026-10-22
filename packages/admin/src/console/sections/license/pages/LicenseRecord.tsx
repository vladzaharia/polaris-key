/**
 * The license record (ADMIN.md §6.5.2, T3; licenses.detail). The header carries the status, the
 * holder and the id, the **Tier: X ▾** control, one primary action and a menu (LDT-7, LDT-8).
 * Route tabs (LDT-4): Status (`overview`: Limits, Devices, Duration, Origin), Keys, Devices,
 * Activity and Config.
 *
 * LX-30 (S-24 §8.8): the holder variants. A license **waiting** for its holder leads with an
 * Invitation card and **Resend invitation**; a **floating** one with Anyone with the key and
 * **Assign to a person**. Reassign and Make floating are I-12's relink tool (L3 typed); the
 * newest move shows its **Undo…** for 72 hours.
 */

import * as React from "react";
import {
  ChevronDown,
  KeyRound,
  Layers,
  Power,
  Send,
  UserPlus,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type LicenseDetail } from "../../../../api.js";
import { useMe, useProduct } from "../../../data/hooks.js";
import { mutate } from "../../../data/mutations.js";
import { qk } from "../../../data/queries.js";
import { r } from "../../../routes.js";
import { navigate } from "../../../router.js";
import { Breadcrumbs } from "../../../components/Breadcrumbs.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { PageTabs } from "../../../components/PageTabs.js";
import { LicenseRegistryTokens } from "../../feeds/pages/RegistryTokens.js";
import { confirmFor } from "../../../../lib/actions.js";
import { fromSeconds } from "../../../../lib/format.js";
import { SIGN_IN_LABELS } from "../../../../lib/labels.js";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { EmptyState } from "../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { PageSkeleton } from "../../../../ui/Skeleton.js";
import { toast } from "../../../../ui/toast.js";
import { LicenseConfig } from "./LicenseConfig.js";
import { LicenseDevices } from "./LicenseDevices.js";
import { DeviceLimitSheet } from "./LicenseDeviceLimit.js";
import {
  EditHolderDialog,
  OfflineBundleDialog,
} from "../components/LicenseDialogs.js";
import {
  AssignDialog,
  MakeFloatingDialog,
  ReassignDialog,
  UndoHolderMoveDialog,
  UndoableMoveCallout,
} from "../components/LicenseHolderDialogs.js";
import {
  holderOf,
  licenseTitle,
  undoableMove,
  useLicenseBatch,
  useLicenseHolderMoves,
} from "../components/holders.js";
import { DeleteLicenseDialog, deletionBlockedReason } from "./LicenseDelete.js";
import { LicenseKeys, MintKeyDialog } from "./LicenseKeys.js";
import { SendKeyDialog, type UnsentKey } from "../components/SendKeyDialog.js";
import { ExpiryDialog, ProfilesDialog } from "./LicenseTerms.js";
import { LicenseActivity } from "./LicenseActivity.js";
import { ChangeTierDialog } from "../components/ChangeTierDialog.js";
import {
  HeaderStatus,
  RecordFacts,
  StatusTab,
  useFocusTitleAfterUndo,
  type RecordDialog,
} from "../components/LicenseRecordParts.js";
import {
  actorName,
  daysUntil,
  expiryText,
  seatLimitOf,
  seatLimitText,
  useTiers,
} from "../components/shared.js";

export const LICENSE_TABS = [
  "overview",
  "keys",
  "devices",
  "activity",
  "config",
] as const;
export type LicenseTab = (typeof LICENSE_TABS)[number];

export function useLicense(slug: string, id: string) {
  return useQuery({
    queryKey: qk.license(slug, id),
    queryFn: () => api.license(slug, id),
  });
}

export function LicenseRecord({
  slug,
  id,
  tab: rawTab,
}: {
  slug: string;
  id: string;
  tab?: string;
}): React.ReactElement {
  const tab: LicenseTab = (LICENSE_TABS as readonly string[]).includes(
    rawTab ?? "",
  )
    ? (rawTab as LicenseTab)
    : "overview";
  const q = useLicense(slug, id);
  const license = q.data;

  if (q.isPending) {
    return <PageSkeleton template="record" label="license" />;
  }
  if (!license) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={
            <Breadcrumbs
              items={[
                { label: "Licenses", to: r.licenses(slug) },
                { label: id },
              ]}
            />
          }
          title={notFound ? "License not found" : "License"}
        />
        {notFound ? (
          <EmptyState
            kind="not-found"
            title="This license doesn't exist"
            description="It may have been deleted, or the link has a typo."
            primaryAction={
              <Button
                variant="outline"
                onClick={() => navigate(r.licenses(slug))}
              >
                Back to licenses
              </Button>
            }
          />
        ) : (
          <ErrorState
            error={q.error}
            onRetry={() => void q.refetch()}
            context={{ thing: "License", collectionHref: r.licenses(slug) }}
          />
        )}
      </div>
    );
  }
  return (
    <LicenseRecordBody
      slug={slug}
      license={license}
      tab={tab}
      refetching={q.isFetching}
    />
  );
}

function LicenseRecordBody({
  slug,
  license,
  tab,
  refetching,
}: {
  slug: string;
  license: LicenseDetail;
  tab: LicenseTab;
  refetching: boolean;
}): React.ReactElement {
  const me = useMe().data;
  const product = useProduct(slug).data;
  const tiers = useTiers(slug).data?.tiers ?? [];
  const [handoff, setHandoff] = React.useState<{
    unsent: UnsentKey;
    email: string;
  } | null>(null);
  const [dialog, setDialog] = React.useState<RecordDialog>(null);
  // Config overrides keep their draft across tab switches once opened (the editor owns it).
  const [configOpened, setConfigOpened] = React.useState(tab === "config");
  React.useEffect(() => {
    if (tab === "config") setConfigOpened(true);
  }, [tab]);

  const id = license.id;
  const active = license.status === "active";
  // Status stays "active" past expiresAt, but a key emailed then would not activate.
  const expired =
    license.expiresAt != null && fromSeconds(license.expiresAt) <= Date.now();
  const holder = holderOf(license);
  const floating = holder.kind === "floating";
  const inAccount = holder.kind === "assigned" && holder.inAccount;
  const batch = useLicenseBatch(slug, license.batchId ?? null).data ?? null;
  const moves = useLicenseHolderMoves(slug, id).data?.relinks;
  const undoable = undoableMove(moves);
  const [undoing, setUndoing] = React.useState<typeof undoable>(null);
  // ADMIN.md §5.6: an undo removes the callout whose button opened it (see the hook).
  const focusAfterUndo = useFocusTitleAfterUndo(
    undoable?.id ?? null,
    undoing !== null,
  );
  // PX-W9: a licence with no account counts the devices that entered its key (Identity on).
  const keyEntries = inAccount ? null : (license.keyEntries ?? null);
  // LX-14a: the limit the Worker enforces and where it comes from.
  const seats = seatLimitOf(license, tiers, product?.defaultDeviceLimit);
  const limit = seats.limit;
  const activeKeys = license.keys.filter((k) => k.status === "active").length;
  const configOn = product?.services?.config?.enabled ?? true;

  const toggle = async (enable: boolean): Promise<void> => {
    await mutate("setLicenseEnabled", slug, id, enable);
    toast.success(enable ? "License enabled" : "License disabled");
  };

  const changedBy = actorName(license.modifiedBy, me);
  const waiting = holder.kind === "assigned" && !holder.inAccount;
  const resendable =
    waiting && active && !expired && Boolean(license.email?.trim());
  const tier = license.tier ? tiers.find((t) => t.id === license.tier) : null;
  const tierLabel = license.tier ? tier?.label || license.tier : null;

  const tabHref = (t: LicenseTab) =>
    r.license(slug, id, t === "overview" ? undefined : t);

  // Tier: X ▾ opens Change tier; with no tier the value is muted "No tier" (CONSOLE-UX D12).
  const tierControl = (
    <Button
      variant="outline"
      // A long tier name truncates (full name in the title and aria-label). Not at 200 % text
      // on a phone: Change tier… is in More actions.
      className="max-w-full sm:max-w-[16rem] max-sm:conbig:hidden"
      aria-haspopup="dialog"
      aria-label={`Tier: ${tierLabel ?? "No tier"}. Change tier`}
      iconStart={<Layers />}
      iconEnd={<ChevronDown />}
      onClick={() => setDialog("tier")}
    >
      <span className="text-fg-muted conbig:sr-only">Tier</span>
      {tierLabel ? (
        <span
          title={tierLabel}
          className="min-w-0 max-w-56 truncate max-sm:max-w-full max-sm:conbig:whitespace-normal"
        >
          {tierLabel}
        </span>
      ) : (
        <span className="text-fg-muted">No tier</span>
      )}
    </Button>
  );
  const mainAction = !active ? (
    <Button iconStart={<Power />} onClick={() => setDialog("enable")}>
      Enable license
    </Button>
  ) : floating ? (
    // S-24 §8.8, frame 77: a floating licence's one action is to give it a holder.
    <Button iconStart={<UserPlus />} onClick={() => setDialog("assign")}>
      Assign to a person
    </Button>
  ) : resendable ? (
    <Button iconStart={<Send />} onClick={() => setDialog("send")}>
      Resend invitation
    </Button>
  ) : (
    <Button
      variant="outline"
      iconStart={<KeyRound />}
      onClick={() => setDialog("mint")}
    >
      Add key
    </Button>
  );

  // Drawn twice, CSS picks one: under the title, or under the tabs (phone, 200 % text, short).
  const facts = (primary: boolean): React.ReactElement => (
    <RecordFacts
      primary={primary}
      license={license}
      waiting={waiting}
      holderEmail={
        inAccount && holder.kind === "assigned" ? holder.email : null
      }
      inAccount={inAccount}
      keyEntries={keyEntries}
      changedBy={changedBy}
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Breadcrumbs
            items={[
              { label: "Licenses", to: r.licenses(slug) },
              { label: licenseTitle(license) },
            ]}
          />
        }
        title={
          // The other end of the Licenses table's name (S-23 §6.1 shared-element): named
          // `pk-key` during a drill-down, fit-content like its source.
          <span className="pk-vt-key w-fit max-w-full line-clamp-2">
            {licenseTitle(license)}
          </span>
        }
        // At 200 % text the masthead has no room for a third line: the status moves to the
        // facts strip below the tabs (CSS only; the other copy is `display: none`).
        titleAside={
          <span className="conbig:hidden">
            <HeaderStatus license={license} waiting={waiting} />
          </span>
        }
        // The tier is a control beside the one action (licenses.detail): 50/50 on a phone.
        primaryAction={
          <div className="grid grid-cols-2 gap-2 max-sm:conbig:grid-cols-1 sm:flex [&>button]:min-w-0 max-sm:[&>button]:whitespace-normal conbig:sm:[&>button]:whitespace-nowrap!">
            {tierControl}
            {mainAction}
          </div>
        }
        inlineSecondary={0}
        menuLast
        secondaryActions={[
          { label: "Change tier…", onSelect: () => setDialog("tier") },
          ...(floating
            ? active
              ? []
              : [{ label: "Assign…", onSelect: () => setDialog("assign") }]
            : [{ label: "Edit holder…", onSelect: () => setDialog("holder") }]),
          ...(active && !floating && !resendable
            ? []
            : [{ label: "Add key…", onSelect: () => setDialog("mint") }]),
          { label: "Edit profiles…", onSelect: () => setDialog("profiles") },
          {
            label: "Mint offline bundle…",
            onSelect: () => setDialog("bundle"),
          },
          { label: "Device limit…", onSelect: () => setDialog("deviceLimit") },
          // LX-27: an assigned licence's key can be emailed anew (a floating one has no address).
          ...(floating || !active || expired || !license.email?.trim()
            ? []
            : [
                { label: "Send a new key…", onSelect: () => setDialog("send") },
              ]),
          // S-24 §8.8: Reassign lives in the overflow, beside Make floating in its danger part.
          ...(floating
            ? []
            : [{ label: "Reassign…", onSelect: () => setDialog("reassign") }]),
          {
            label: "View in activity",
            onSelect: () => navigate(r.activity(slug, { q: id })),
          },
        ]}
        dangerActions={[
          ...(floating
            ? []
            : [
                {
                  label: "Make floating…",
                  onSelect: () => setDialog("floating"),
                },
              ]),
          ...(active
            ? [
                {
                  label: "Disable license…",
                  onSelect: () => setDialog("disable"),
                },
              ]
            : []),
          {
            label: "Delete license…",
            onSelect: () => setDialog("delete"),
            disabledReason: deletionBlockedReason(license.deletion),
          },
        ]}
        factsRow={
          <span className="hidden sm:flex conbig:hidden short:hidden">
            {facts(true)}
          </span>
        }
        refetching={refetching}
        tabs={
          <PageTabs
            label="License sections"
            value={tab}
            items={[
              { value: "overview", label: "Status", to: tabHref("overview") },
              {
                value: "keys",
                label: "Keys",
                to: tabHref("keys"),
                count: activeKeys,
              },
              {
                value: "devices",
                label: "Devices",
                to: tabHref("devices"),
                count:
                  limit === null
                    ? license.deviceCount
                    : `${license.deviceCount}/${limit}`,
              },
              {
                value: "activity",
                label: "Activity",
                to: tabHref("activity"),
              },
              {
                value: "config",
                label: "Config overrides",
                to: tabHref("config"),
              },
            ]}
          />
        }
      />

      <div className="hidden text-sm text-fg-muted max-sm:block conbig:block short:block">
        {facts(false)}
      </div>

      {undoable ? (
        <UndoableMoveCallout
          move={undoable}
          onUndo={() => setUndoing(undoable)}
        />
      ) : null}
      {/* Each panel is a `pk-vt-tabpanel`: the visible one fades through on a tab switch
          (S-23 §6.1); a hidden one is not rendered, so it takes no part. */}
      {tab === "overview" ? (
        <div className="pk-vt-tabpanel">
          <StatusTab
            slug={slug}
            license={license}
            tiers={tiers}
            product={product}
            seats={seats}
            batch={batch}
            me={me}
            onDialog={setDialog}
          />
        </div>
      ) : null}
      {tab === "keys" ? (
        <div className="pk-vt-tabpanel space-y-6">
          <LicenseKeys slug={slug} license={license} />
          {/* F-21: tokens bound to this licence, while the product's package feeds are on. */}
          {product?.packageFeeds ? (
            <LicenseRegistryTokens slug={slug} licenseId={id} />
          ) : null}
        </div>
      ) : null}
      {tab === "devices" ? (
        <div className="pk-vt-tabpanel">
          <LicenseDevices slug={slug} license={license} seats={seats} />
        </div>
      ) : null}
      {tab === "activity" ? (
        <div className="pk-vt-tabpanel">
          <LicenseActivity slug={slug} id={id} />
        </div>
      ) : null}
      {configOpened ? (
        <div hidden={tab !== "config"} className="pk-vt-tabpanel">
          <LicenseConfig slug={slug} license={license} configOn={configOn} />
        </div>
      ) : null}

      <ChangeTierDialog
        slug={slug}
        license={license}
        tiers={tiers}
        product={product}
        open={dialog === "tier"}
        onOpenChange={(o) => setDialog(o ? "tier" : null)}
      />
      <ExpiryDialog
        slug={slug}
        license={license}
        open={dialog === "expiry"}
        onOpenChange={(o) => setDialog(o ? "expiry" : null)}
      />
      <ProfilesDialog
        slug={slug}
        license={license}
        open={dialog === "profiles"}
        onOpenChange={(o) => setDialog(o ? "profiles" : null)}
      />
      <EditHolderDialog
        slug={slug}
        license={license}
        open={dialog === "holder"}
        onOpenChange={(o) => setDialog(o ? "holder" : null)}
      />
      <AssignDialog
        slug={slug}
        license={license}
        open={dialog === "assign"}
        onOpenChange={(o) => setDialog(o ? "assign" : null)}
        onUnsent={(unsent, email) => {
          setHandoff({ unsent, email });
          setDialog("send");
        }}
      />
      <ReassignDialog
        slug={slug}
        license={license}
        open={dialog === "reassign"}
        onOpenChange={(o) => setDialog(o ? "reassign" : null)}
      />
      <MakeFloatingDialog
        slug={slug}
        license={license}
        open={dialog === "floating"}
        onOpenChange={(o) => setDialog(o ? "floating" : null)}
      />
      <UndoHolderMoveDialog
        slug={slug}
        licenseId={id}
        move={undoing}
        onClose={() => setUndoing(null)}
        onUndone={() => {
          focusAfterUndo.current = true;
        }}
      />
      <DeviceLimitSheet
        slug={slug}
        license={license}
        tiers={tiers}
        productLimit={product?.defaultDeviceLimit}
        open={dialog === "deviceLimit"}
        onOpenChange={(o) => setDialog(o ? "deviceLimit" : null)}
      />
      <OfflineBundleDialog
        slug={slug}
        licenseId={id}
        configOn={configOn}
        open={dialog === "bundle"}
        onOpenChange={(o) => setDialog(o ? "bundle" : null)}
      />
      <MintKeyDialog
        slug={slug}
        licenseId={id}
        open={dialog === "mint"}
        onOpenChange={(o) => setDialog(o ? "mint" : null)}
      />
      <SendKeyDialog
        slug={slug}
        licenseId={id}
        email={handoff?.email ?? license.email?.trim() ?? ""}
        initial={handoff?.unsent ?? null}
        context={handoff ? "assigned" : undefined}
        onMint={() => setDialog("mint")}
        open={dialog === "send"}
        onOpenChange={(o) => {
          setDialog(o ? "send" : null);
          if (!o) setHandoff(null);
        }}
      />
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent={confirmFor("license.disable").intent as "caution"}
        title={`Disable ${license.name || "this license"}?`}
        consequences={[
          "Its devices stop authenticating right away: their cached tokens are purged.",
          "Keys, devices and terms are kept. Enabling the license restores access.",
        ]}
        confirmLabel="Disable license"
        onConfirm={() => toggle(false)}
      />
      <DeleteLicenseDialog
        slug={slug}
        license={license}
        open={dialog === "delete"}
        onOpenChange={(o) => setDialog(o ? "delete" : null)}
      />
      <ConfirmDialog
        open={dialog === "enable"}
        onOpenChange={(o) => !o && setDialog(null)}
        intent={confirmFor("license.enable").intent as "caution"}
        title={`Enable ${license.name || "this license"}?`}
        consequences={["Its devices regain access at their next check-in."]}
        confirmLabel="Enable license"
        onConfirm={() => toggle(true)}
      />
    </div>
  );
}
