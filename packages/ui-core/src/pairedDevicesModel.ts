// `PairedDevicesModel` (CC-29K): the list of devices this one paired with by a code, over the same
// `LocalLinksLike` driver as `LocalPairingModel`. It re-reads `list()` on `onChange`, so a pairing,
// a rename in another window, a forget or a gate flip shows without a refresh.
//
//   - rows: the switch column's rule is `showSwitchColumn` (more than 8, or one off);
//   - Rename and Forget work in the row (M9): a refused name keeps its text and says why; after a
//     Forget focus moves to the next row, or the title when none is left;
//   - a switch the SDK refuses with `cap: "reachable"` says "Up to 8 can connect", never the
//     32-device copy; an unreadable record is "load-failed" with Try again;
//   - with the gate off only Rename and Forget remain, and the host's entry shows while a link is
//     held (`entryVisible`).

import { contextOf, type PairedDevicesInput, type UiInput } from "./input.js";
import type { LocalLinkLike, LocalLinksLike } from "./localPairingModel.js";
import { MAX_NAME, pairedDevicesView } from "./models/local.js";
import { createStore, type Deliver, type Store } from "./store.js";
import type { View } from "./view.js";

/** Where focus goes after a Forget. */
export type PairedFocus =
  | { kind: "row"; id: string }
  | { kind: "title" }
  | null;

export interface PairedDevicesSnapshot extends PairedDevicesInput {
  /** The text in the rename field. */
  draft: string;
  /** Set after a Forget; the renderer moves focus and the model clears it on the next change. */
  focus: PairedFocus;
  /** True once the first read finished. */
  loaded: boolean;
  /** The host's "Paired devices" entry shows: pairing is on, or at least one link is held. */
  entryVisible: boolean;
  /** The person left (Done): the host closes the screen. */
  left: boolean;
  /** The person asked to pair another (the host opens Pair with a Code). */
  pairAnother: boolean;
}

export interface PairedDevicesOptions {
  driver: LocalLinksLike;
  base?: UiInput;
  deliver?: Deliver;
}

export class PairedDevicesModel {
  readonly store: Store<PairedDevicesSnapshot>;
  base: UiInput;
  private readonly driver: LocalLinksLike;
  private unsubscribe: (() => void) | null = null;
  /** Bumped by each read, so a slow older read never overwrites a newer one. */
  private reads = 0;

  constructor(options: PairedDevicesOptions) {
    this.driver = options.driver;
    this.base = options.base ?? {};
    this.store = createStore<PairedDevicesSnapshot>(
      {
        step: "list",
        devices: [],
        draft: "",
        focus: null,
        loaded: false,
        entryVisible: false,
        left: false,
        pairAnother: false,
      },
      { deliver: options.deliver },
    );
  }

  get snapshot(): PairedDevicesSnapshot {
    return this.store.get();
  }

  input(): UiInput {
    const {
      draft: _draft,
      focus: _focus,
      loaded: _loaded,
      entryVisible: _entry,
      left: _left,
      pairAnother: _pair,
      ...list
    } = this.store.get();
    return { ...this.base, pairedDevices: list };
  }

  view(): View<"PairedDevices"> {
    return pairedDevicesView(contextOf(this.input())) as View<"PairedDevices">;
  }

  /** Read the list and follow the SDK's changes until `stop()`. */
  async start(): Promise<void> {
    this.unsubscribe ??= this.driver.onChange(() => void this.refresh());
    await this.refresh();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Read `list()` and the gate again (also Try again). */
  async refresh(): Promise<void> {
    const read = ++this.reads;
    const on = this.driver.localPairing();
    let rows: readonly LocalLinkLike[];
    try {
      rows = await this.driver.list();
    } catch {
      if (read !== this.reads) return;
      this.store.set((s) => ({
        ...s,
        step: "load-failed",
        devices: [],
        loaded: true,
        entryVisible: false,
      }));
      return;
    }
    if (read !== this.reads) return;
    this.store.set((s) => {
      const devices = rows.map((r) => ({
        id: r.id,
        label: r.label,
        lastSeen: r.lastSeen,
        reachable: r.reachable,
        platform: r.platform ?? null,
      }));
      const editing = s.step === "renaming" || s.step === "forgetting";
      const stillThere = editing && devices.some((d) => d.id === s.target);
      return {
        ...s,
        devices,
        loaded: true,
        entryVisible: on || devices.length > 0,
        step: !on ? "off" : stillThere ? s.step : "list",
        ...(!on || !stillThere
          ? { target: undefined, renameError: undefined }
          : {}),
      };
    });
  }

  // ── Rows ──────────────────────────────────────────────────────────────────────────────────────

  /** Rename, from the row's menu. The field starts with the name now held. */
  startRename(id: string): void {
    const d = this.store.get().devices?.find((x) => x.id === id);
    if (!d) return;
    this.store.set((s) => ({
      ...s,
      step: "renaming",
      target: id,
      draft: d.label ?? "",
      renameError: undefined,
      focus: null,
    }));
  }

  setDraft(text: string): void {
    this.store.set((s) =>
      s.step === "renaming" ? { ...s, draft: text, renameError: undefined } : s,
    );
  }

  /** Save: a refused name keeps its text and focus and says why. Nothing is sent to the other device. */
  async saveRename(): Promise<void> {
    const s = this.store.get();
    if (s.step !== "renaming" || !s.target) return;
    const name = s.draft.trim();
    const error =
      name === "" ? "empty" : [...name].length > MAX_NAME ? "long" : undefined;
    if (error) {
      this.store.set((x) => ({ ...x, renameError: error }));
      return;
    }
    try {
      await this.driver.rename(s.target, name);
    } catch {
      // The SDK refused what the screen could not tell (a name that cleans to nothing).
      this.store.set((x) => ({ ...x, renameError: "empty" }));
      return;
    }
    this.endEdit();
    await this.refresh();
  }

  /** Forget, from the row's menu: asks inside the row. */
  askForget(id: string): void {
    if (!this.store.get().devices?.some((d) => d.id === id)) return;
    this.store.set((s) => ({
      ...s,
      step: "forgetting",
      target: id,
      renameError: undefined,
      focus: null,
    }));
  }

  /** Forget: deletes it here only; the other device is not told. Focus moves on. */
  async confirmForget(): Promise<void> {
    const s = this.store.get();
    if (s.step !== "forgetting" || !s.target) return;
    const rows = s.devices ?? [];
    const at = rows.findIndex((d) => d.id === s.target);
    const next = rows[at + 1] ?? rows[at - 1];
    await this.driver.remove(s.target).catch(() => false);
    this.endEdit();
    await this.refresh();
    const left = this.store.get().devices ?? [];
    this.store.set((x) => ({
      ...x,
      focus:
        next && left.some((d) => d.id === next.id)
          ? { kind: "row", id: next.id }
          : { kind: "title" },
    }));
  }

  /** Cancel an edit: the row is as it was. */
  cancelEdit(): void {
    this.endEdit();
  }

  private endEdit(): void {
    this.store.set((s) => ({
      ...s,
      step: this.driver.localPairing() ? "list" : "off",
      target: undefined,
      renameError: undefined,
      draft: "",
    }));
  }

  /** A Can connect switch. A ninth is refused by the SDK (`cap: "reachable"`); the list says "Up to
   *  8 can connect" itself, so the refusal changes nothing but the re-read that puts the switch back. */
  async setReachable(id: string, on: boolean): Promise<void> {
    await this.driver.setReachable(id, on).catch(() => undefined);
    await this.refresh();
  }

  /** The answer of the app's own connection to a device, shown with the list. */
  report(id: string, kind: "not-found" | "busy" | "unknown" | null): void {
    const d = this.store.get().devices?.find((x) => x.id === id);
    this.store.set((s) => ({
      ...s,
      notice: kind && d ? { device: d.label ?? "", kind } : undefined,
    }));
  }

  /** Pair with a Code, the one primary. */
  requestPair(): void {
    this.store.set((s) => ({ ...s, pairAnother: true }));
  }

  /** Done. */
  done(): void {
    this.stop();
    this.store.set((s) => ({ ...s, left: true }));
  }
}
