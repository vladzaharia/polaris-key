import * as React from "react";
import { Button } from "../../../ui/Button.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { announce } from "../../../ui/LiveRegion.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { t } from "../../../lib/copy.js";
import { PORTAL_FMT } from "../../date.js";
import {
  HttpError,
  type PortalConnectedApp,
  type PortalConnectedGet,
  type PortalConnectedProduct,
} from "../../api.js";
import {
  useChangeConnectedApp,
  useConnectedApps,
  useDisconnectConnectedApp,
} from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { focusSectionHeading } from "../../focus.js";
import {
  InlinePanel,
  RemovePanel,
  useRemoveConfirm,
} from "../product/DeviceRowParts.js";
import { ProductIcon } from "../ProductIcon.js";
import { ClientRow } from "../signin/ClientConsentStep.js";
import { GetChip, clientGetText } from "../signin/clientGets.js";
import { AccountCard as SectionCard } from "./AccountCard.js";
import { devicesVisible } from "./DevicesSection.js";

type Claim = "name" | "picture" | "email";
const isClaim = (item: PortalConnectedGet["item"]): item is Claim =>
  item === "name" || item === "picture" || item === "email";

/**
 * Connected apps (I-21.15): the apps the person signed in to with a product's account, one group per
 * product. A row names the app (and its developer when another company makes it), where it returns
 * people and when it last signed them in, and what it gets as chips. **Change** opens a panel in the
 * row with a switch per optional item the person already decided; **Disconnect** opens the confirm
 * in place, as Devices does. An app that cannot sign anyone in now stays listed as "<Product> turned
 * this app off", with Disconnect only. The section is absent while it loads, with nothing connected
 * and on a Worker without the route ({@link connectedAppsVisible}).
 */
export function ConnectedAppsSection({
  shown,
}: {
  /** The page's verdict ({@link connectedAppsVisible}); the nav entry follows the same one. */
  shown: boolean;
}): React.ReactElement | null {
  const apps = useConnectedApps();
  if (!shown) return null;
  const groups = (apps.data ?? []).filter((g) => g.clients.length > 0);
  return (
    <SectionCard
      id="apps"
      title={t("locker.apps.title")}
      subtitle={t("locker.apps.subtitle")}
    >
      {apps.error ? (
        <ErrorState
          account
          error={apps.error}
          onRetry={() => void apps.refetch()}
          message={t("locker.error.loadFailedApps")}
          className="border-0 p-0 shadow-none"
        />
      ) : groups.length === 0 ? (
        <p className="text-sm text-fg-muted" data-apps-empty="">
          {t("locker.apps.none")}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <Group key={g.product} group={g} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Whether the Connected apps card (and its nav entry) shows: while it has rows, after they were all
 * disconnected this visit, on a failed load, and when the page was opened at it. Hidden while it
 * loads and on a Worker without the route (404). `hadRows` is the page's ref, set here.
 */
export function connectedAppsVisible(
  query: {
    isPending: boolean;
    error: unknown;
    data: PortalConnectedProduct[] | null | undefined;
  },
  hadRows: { current: boolean },
  wanted: boolean,
): boolean {
  return devicesVisible(
    { ...query, data: query.data?.flatMap((g) => g.clients) },
    hadRows,
    wanted,
  );
}

function Group({
  group,
}: {
  group: PortalConnectedProduct;
}): React.ReactElement {
  const headingId = `apps-${group.product}-h`;
  return (
    <section aria-labelledby={headingId} data-apps-product={group.product}>
      <h3 id={headingId} className="mb-1 text-sm font-medium text-fg-muted">
        {t("locker.apps.group", { product: group.name })}
      </h3>
      <ul className="-mx-4 divide-y divide-border border-y border-border desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
        {group.clients.map((c) => (
          <AppRow key={c.clientId} group={group} app={c} />
        ))}
      </ul>
    </section>
  );
}

function AppRow({
  group,
  app,
}: {
  group: PortalConnectedProduct;
  app: PortalConnectedApp;
}): React.ReactElement {
  const { confirming, setConfirming, headingRef, removeRef, keep } =
    useRemoveConfirm();
  const [changing, setChanging] = React.useState(false);
  const changeRef = React.useRef<HTMLButtonElement>(null);
  const disconnect = useDisconnectConnectedApp();
  const changeable =
    app.available && app.gets.some((g) => !g.fixed && isClaim(g.item));
  const granted = app.gets.filter((g) => g.granted || isClaim(g.item));
  const when = formatRelative(
    (app.lastUsedAt ?? app.grantedAt) * 1000,
    Date.now(),
    PORTAL_FMT,
  );
  const meta = [
    app.returnHost,
    t(app.lastUsedAt ? "locker.apps.lastUsed" : "locker.apps.connected", {
      when,
    }),
  ]
    .filter(Boolean)
    .join(" · ");
  const panelId = `disconnect-${group.product}-${app.clientId}`;
  const changeId = `change-${group.product}-${app.clientId}`;
  const busy = confirming || changing;
  return (
    <li className="py-4 @container" data-client={app.clientId}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 @[34rem]:grid-cols-[auto_minmax(0,1fr)_auto]">
        <ProductIcon
          slug={group.product}
          name={app.name}
          tint={null}
          size={40}
          src={app.iconUrl ?? group.iconUrl}
        />
        <div className="min-w-0 space-y-2">
          <div>
            <p className="flex flex-wrap items-baseline gap-x-2 break-words font-semibold text-fg-strong">
              <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">
                {app.name}
              </span>
              {app.partner && app.developer ? (
                <span className="text-sm font-normal text-fg-muted">
                  {t("locker.apps.by", { developer: app.developer })}
                </span>
              ) : null}
            </p>
            <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
              {meta}
            </p>
          </div>
          {app.available ? (
            <ul
              aria-label={t("locker.apps.gets", { app: app.name })}
              className="flex flex-wrap gap-2"
            >
              {granted.map((g) => (
                <GetChip
                  key={g.item}
                  item={g.item}
                  granted={g.granted}
                  product={group.name}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg" data-app-off="">
              {t("locker.apps.off", { product: group.name })}
            </p>
          )}
        </div>
        {busy ? null : (
          <div className="col-start-2 flex flex-wrap gap-2 @[34rem]:col-start-3 @[34rem]:row-start-1 @[34rem]:justify-end">
            {changeable ? (
              <Button
                ref={changeRef}
                variant="quiet"
                size="md"
                aria-label={t("locker.apps.changeName", { app: app.name })}
                aria-expanded={false}
                aria-controls={changeId}
                onClick={() => setChanging(true)}
              >
                {t("locker.apps.change")}
              </Button>
            ) : null}
            <Button
              ref={removeRef}
              variant="quiet"
              size="md"
              aria-label={t("locker.apps.disconnectName", { app: app.name })}
              aria-expanded={false}
              aria-controls={panelId}
              onClick={() => setConfirming(true)}
            >
              {t("locker.apps.disconnect")}
            </Button>
          </div>
        )}
      </div>
      {changeable ? (
        <ChangePanel
          id={changeId}
          open={changing}
          group={group}
          app={app}
          onClose={() => {
            setChanging(false);
            requestAnimationFrame(() => changeRef.current?.focus());
          }}
        />
      ) : null}
      <RemovePanel
        id={panelId}
        open={confirming}
        name={app.name}
        headingRef={headingRef}
        copy={{
          title: t("locker.apps.disconnectAsk", { app: app.name }),
          failed:
            disconnect.error instanceof HttpError &&
            disconnect.error.status === 429
              ? portalErrorCopy(disconnect.error).line
              : t("locker.apps.disconnectFailed", { app: app.name }),
          keep: t("locker.apps.keep", { app: app.name }),
          confirm: t("locker.apps.disconnectName", { app: app.name }),
          confirmName: t("locker.apps.disconnectName", { app: app.name }),
          body: app.developer
            ? t("locker.apps.disconnectBody", {
                app: app.name,
                developer: app.developer,
              })
            : t("locker.apps.disconnectBodyNoDev", { app: app.name }),
        }}
        note={t("locker.apps.disconnectAgain")}
        error={Boolean(disconnect.error)}
        removing={disconnect.isPending}
        onKeep={() => {
          disconnect.reset();
          keep();
        }}
        onRemove={() =>
          disconnect.mutate(
            { product: group.product, clientId: app.clientId },
            {
              onSuccess: () => {
                toast.success(t("locker.apps.disconnected", { app: app.name }));
                announce(t("locker.apps.disconnected", { app: app.name }));
                // The row leaves with the refetch; the card stays, so its heading is always there.
                focusSectionHeading("apps");
              },
            },
          )
        }
      />
    </li>
  );
}

/**
 * Change what the app gets: a switch per optional item the person already decided, each fixed item
 * marked "Needed by <App>" (only Disconnect removes those). Save sends the switches that moved; a
 * `409` (the app's access changed underneath) offers Reload and keeps the panel as it is. Escape and
 * Cancel return focus to Change.
 */
function ChangePanel({
  id,
  open,
  group,
  app,
  onClose,
}: {
  id: string;
  open: boolean;
  group: PortalConnectedProduct;
  app: PortalConnectedApp;
  onClose: () => void;
}): React.ReactElement {
  const change = useChangeConnectedApp();
  const apps = useConnectedApps();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = React.useState<Partial<Record<Claim, boolean>>>({});
  const items = app.gets.filter((g) => g.granted || isClaim(g.item));
  const on = (g: PortalConnectedGet): boolean =>
    isClaim(g.item) ? (draft[g.item] ?? g.granted) : g.granted;
  const moved = items.flatMap((g) =>
    isClaim(g.item) && !g.fixed && on(g) !== g.granted
      ? [[g.item, on(g)] as const]
      : [],
  );
  const close = (): void => {
    setDraft({});
    change.reset();
    onClose();
  };
  const conflict =
    change.error instanceof HttpError && change.error.status === 409;
  const failure = change.error
    ? conflict
      ? t("locker.apps.conflict")
      : change.error instanceof HttpError && change.error.status === 429
        ? portalErrorCopy(change.error).line
        : t("locker.apps.saveFailed")
    : null;
  const save = (): void =>
    change.mutate(
      {
        product: group.product,
        clientId: app.clientId,
        claims: Object.fromEntries(moved),
      },
      {
        onSuccess: () => {
          toast.success(t("locker.apps.saved"));
          announce(t("locker.apps.savedAnnounce", { app: app.name }));
          close();
        },
        // The grant is gone (disconnected in another tab): the list is read again and the row leaves.
        onError: (err) => {
          if (err instanceof HttpError && err.status === 404) {
            void apps.refetch();
            close();
          }
        },
      },
    );
  return (
    <InlinePanel id={id} open={open} headingRef={headingRef} onEscape={close}>
      <div className="space-y-3 rounded-lg border border-border-strong bg-surface-sunken p-4 @container">
        <h4
          ref={headingRef}
          tabIndex={-1}
          className="font-medium text-fg-strong outline-none"
        >
          {t("locker.apps.gets", { app: app.name })}
        </h4>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
          {items.map((g) => (
            <ClientRow
              key={g.item}
              line={{
                id: g.item,
                text: clientGetText(g.item, group.name),
                label: isClaim(g.item)
                  ? t(`locker.issuer.share.${g.item}`, { app: app.name })
                  : "",
                required: g.fixed,
                claim: isClaim(g.item),
                startsOff: false,
              }}
              lock={t("locker.apps.needed", { app: app.name })}
              on={on(g)}
              onToggle={() =>
                isClaim(g.item) && setDraft((d) => ({ ...d, [g.item]: !on(g) }))
              }
            />
          ))}
        </ul>
        {failure ? (
          <p role="alert" className="text-sm text-danger">
            {failure}{" "}
            {conflict ? (
              <Button
                variant="link"
                onClick={() => {
                  void apps.refetch();
                  close();
                }}
              >
                {t("locker.apps.reload")}
              </Button>
            ) : null}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 @[22rem]:flex-row @[22rem]:justify-end">
          <Button variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="neutral"
            disabled={moved.length === 0}
            loading={change.isPending}
            onClick={save}
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </InlinePanel>
  );
}
