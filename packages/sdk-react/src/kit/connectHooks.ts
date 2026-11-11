"use client";
// The headless half of the inter-account screens (CC-19.9): `useLinkPairing` holds ui-core's
// `LinkPairingModel` for the life of a component and `useTransferOffer` its `TransferOfferModel`,
// and hand a host the input to draw them with. No DOM and no stylesheet: a host that draws its own
// screens loads none of connect.tsx. `linkPairingDriver` binds the Node SDK's
// `cloudConnect.links.pair` (the desktop host's, over its bridge) to the model.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  LinkPairingModel,
  LocalPairingModel,
  PairedDevicesModel,
  TransferOfferModel,
  type LinkPairingDriver,
  type LinkPairingOffer,
  type LinkPairingSnapshot,
  type LocalLinksLike,
  type LocalPairingSnapshot,
  type PairedDevicesSnapshot,
  type Store,
  type TransferOfferDriver,
  type TransferOfferSnapshot,
  type UiInput,
  type View,
} from "@polaris-key/ui-core";

import { ErrorCode } from "../constants.generated.js";

/** What `cloudConnect.links.pair` of the Node SDK takes and returns, as far as the model needs. */
export interface LinksLike {
  pair(o: {
    categories: readonly string[];
    label?: string;
    seconds?: number;
    onCode(offer: LinkPairingOffer): void;
    onLinked(link: {
      label: string | null;
      categories: readonly string[];
    }): void;
    onFailed(f: { reason: "declined" | "timeout" | "full" | "closed" }): void;
  }): Promise<{ stop(): Promise<void> }>;
}

/** The pairing driver over `cloudConnect.links`: the typed `connect_links_disabled` is the model's
 *  `unavailable` state, any other rejection a failed window. */
export function linkPairingDriver(links: LinksLike): LinkPairingDriver {
  return {
    pair: (o) => links.pair(o),
    isUnavailable: (e) =>
      (e as { code?: unknown } | null)?.code === ErrorCode.connectLinksDisabled,
  };
}

// ── LinkPairing ────────────────────────────────────────────────────────────────────────────────

export interface UseLinkPairingOptions {
  driver: LinkPairingDriver;
  /** The data categories this app asks both people to approve (ids, at most 8). */
  categories: readonly string[];
  /** This device's label, sent to the other device. Name the device or the person. */
  label?: string;
  /** Seconds the window stays open (at most 300). */
  seconds?: number;
  /** What the views read besides the step (identity, platform, services). */
  base?: UiInput;
  /** Open the window on mount (default), and close it on unmount. */
  autoStart?: boolean;
}

export interface UseLinkPairing {
  snapshot: LinkPairingSnapshot;
  view: View<"LinkPairing">;
  /** The input to draw the view with: the base and the step. */
  input: UiInput;
  model: LinkPairingModel;
  /** Open the window (Try again). */
  start(): Promise<void>;
  /** Codes match: confirm on this device. */
  confirmMatch(): Promise<void>;
  /** Not a match: close that session; the window stays open. */
  declineMatch(): Promise<void>;
  /** Close the window and any session. */
  cancel(): Promise<void>;
}

export function useLinkPairing(o: UseLinkPairingOptions): UseLinkPairing {
  const ref = useRef<LinkPairingModel | null>(null);
  ref.current ??= new LinkPairingModel({
    driver: o.driver,
    categories: o.categories,
    label: o.label,
    seconds: o.seconds,
    base: o.base,
  });
  const model = ref.current;
  model.base = o.base ?? {};
  const snapshot = useSyncExternalStore(
    model.store.subscribe,
    model.store.get,
    model.store.get,
  );
  const autoStart = o.autoStart !== false;
  useEffect(() => {
    if (autoStart) void model.start();
    return () => void model.cancel();
  }, [model, autoStart]);
  return useMemo(
    () => ({
      snapshot,
      view: model.view(),
      input: model.input(),
      model,
      start: () => model.start(),
      confirmMatch: () => model.confirm(),
      declineMatch: () => model.decline(),
      cancel: () => model.cancel(),
    }),
    // The base can change without a new snapshot; the view is read again with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, model, o.base],
  );
}

// ── TransferOffer ──────────────────────────────────────────────────────────────────────────────

export interface UseTransferOfferOptions {
  /** Answers the host's `onOffer`: accept resolves when everything arrived. */
  driver: TransferOfferDriver;
  /** The contact's label. */
  device?: string | null;
  /** What it offers. */
  name: string;
  /** Its size in bytes and media type, when the contact said. */
  size?: number;
  type?: string;
  base?: UiInput;
}

export interface UseTransferOffer {
  snapshot: TransferOfferSnapshot;
  view: View<"TransferOffer">;
  input: UiInput;
  model: TransferOfferModel;
  accept(): Promise<void>;
  decline(): Promise<void>;
  cancel(): Promise<void>;
  /** Done: close the prompt. */
  close(): void;
}

export function useTransferOffer(o: UseTransferOfferOptions): UseTransferOffer {
  const ref = useRef<TransferOfferModel | null>(null);
  ref.current ??= new TransferOfferModel({
    driver: o.driver,
    device: o.device,
    name: o.name,
    size: o.size,
    type: o.type,
    base: o.base,
  });
  const model = ref.current;
  model.base = o.base ?? {};
  const snapshot = useSyncExternalStore(
    model.store.subscribe,
    model.store.get,
    model.store.get,
  );
  return useMemo(
    () => ({
      snapshot,
      view: model.view(),
      input: model.input(),
      model,
      accept: () => model.accept(),
      decline: () => model.decline(),
      cancel: () => model.cancel(),
      close: () => model.close(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, model, o.base],
  );
}

// ── Pair with a Code ───────────────────────────────────────────────────────────────────────────

export type { LocalLinksLike } from "@polaris-key/ui-core";

/** A store's snapshot, read again on every change. */
function useSnapshot<S>(store: Store<S>): S {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export interface UseLocalPairingOptions {
  /** `client.cloudConnect.localLinks`, or any `LocalLinksLike` (the desktop host's, over its bridge). */
  driver: LocalLinksLike;
  /** The data categories this app asks both people to approve (ids, at most 8). */
  categories: readonly string[];
  /** This device's label, sent to the other device. */
  label?: string;
  /** The system has not asked about the local network yet. */
  prePrompt?: boolean;
  /** The platform can open its settings from the network-blocked answer. */
  canOpenSettings?: boolean;
  base?: UiInput;
}

export interface UseLocalPairing {
  snapshot: LocalPairingSnapshot;
  view: View<"LocalPairing">;
  /** The input to draw the view with: the base and the step. */
  input: UiInput;
  model: LocalPairingModel;
}

/** Pair with a Code: the model reads the gate and the cap on mount and withdraws any code on unmount. */
export function useLocalPairing(o: UseLocalPairingOptions): UseLocalPairing {
  const held = useRef<LocalPairingModel>();
  const model = (held.current ??= new LocalPairingModel({
    ...o,
    categories: o.categories,
  }));
  model.base = o.base ?? {};
  const snapshot = useSnapshot(model.store);
  useEffect(() => {
    void model.start();
    return () => void model.close();
  }, [model]);
  return useMemo(
    () => ({ snapshot, view: model.view(), input: model.input(), model }),
    // The base can change without a new snapshot; the view is read again with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, model, o.base],
  );
}

export interface UsePairedDevicesOptions {
  driver: LocalLinksLike;
  base?: UiInput;
}

export interface UsePairedDevices {
  snapshot: PairedDevicesSnapshot;
  view: View<"PairedDevices">;
  input: UiInput;
  model: PairedDevicesModel;
}

/** The paired devices: read on mount and again on every change the SDK reports. */
export function usePairedDevices(o: UsePairedDevicesOptions): UsePairedDevices {
  const held = useRef<PairedDevicesModel>();
  const model = (held.current ??= new PairedDevicesModel(o));
  model.base = o.base ?? {};
  const snapshot = useSnapshot(model.store);
  useEffect(() => {
    void model.start();
    return () => model.stop();
  }, [model]);
  const view = useMemo(
    () => ({ snapshot, view: model.view(), input: model.input(), model }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, model, o.base],
  );
  return view;
}
