import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type {
  PortalLicenseDetail,
  PortalLicenseSummary,
  PortalProduct,
} from "../src/portal/api.js";
import { DevicesCard } from "../src/portal/components/product/DevicesCard.js";
import { SeatMeter } from "../src/portal/components/SeatMeter.js";
import { createPortalQueryClient } from "../src/portal/data.js";
import { lastAnnouncement } from "../src/ui/LiveRegion.js";
import {
  ACCOUNT,
  DAY,
  detail,
  device,
  fetchedRequests,
  libraryFor,
  license,
  mockFetch,
  NOW_S,
  renderPortal,
  signedIn,
} from "./portalHarness.js";

/**
 * Portal devices and activation moments (notes/S-23 §6.1, §6.4–§6.6; MO-06), as far as jsdom can
 * see them: the list transition around a change to the devices using a seat (what is held, what
 * lands, what a click acts on), the seat meter's pulse and fill, the Activate dialog's step morph
 * and its first-activation moment, and FreeDevicePage's check. jsdom has no View Transitions API
 * and no Web Animations API, so the default path is the instant swap; a fake
 * `startViewTransition` (and, for the meter, a stubbed `getAnimations`) stands in where the
 * transition's timing is under test. The animations themselves run in
 * e2e/deviceMotion.e2e.test.ts.
 *
 * Four rules from the motion reviews are each pinned here: reduced motion reaches the same end
 * state (scroll, focus, content), only instantly; no pending flag outlives its transition; a click
 * while a transition holds the old view acts on the live state; and nothing replays on a refetch
 * or a layout change.
 */

const html = document.documentElement;
type Doc = { startViewTransition?: unknown };

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as Doc).startViewTransition;
  delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
  delete html.dataset.motion;
  delete html.dataset.vt;
});

// ── A fake View Transitions API ─────────────────────────────────────────────────────────────────

interface Start {
  vt: string | undefined;
  /** The device rows on screen when the old state was captured. */
  rows: string[];
  /** The rows once the update ran. */
  after?: string[];
  /** The dialog's title when captured, and after the update. */
  title: string | null;
  titleAfter?: string | null;
  /** The list took part whole (.pk-vt-list), the card was the scope (.pk-vt-scope). */
  list: boolean;
  scope: boolean;
}

interface Fake {
  starts: Start[];
  /** Capture done: run every update not yet run, then finish (the deferred mode). */
  release: () => Promise<void>;
}

type Mode = "auto" | "deferred" | "never";

/**
 * `auto`: the update runs in a microtask and the transition finishes after it. `deferred`: the old
 * state stays on screen until `release()`. `never`: the browser drops the update and only
 * finishes. Skipping a transition runs its update first (as the API does).
 */
function installFake(mode: Mode = "auto"): Fake {
  const starts: Start[] = [];
  const queue: (() => void)[] = [];
  (document as unknown as Doc).startViewTransition = (update: () => void) => {
    const start: Start = {
      vt: html.dataset.vt,
      rows: rowNames(),
      title: dialogTitle(),
      list: !!document.querySelector("#section-devices ul.pk-vt-list"),
      scope: !!document.querySelector("#section-devices.pk-vt-scope"),
    };
    starts.push(start);
    let resolveDone!: () => void;
    let resolveFinished!: () => void;
    const updateCallbackDone = new Promise<void>((r) => (resolveDone = r));
    const finished = new Promise<void>((r) => (resolveFinished = r));
    let ran = false;
    const go = (): void => {
      if (ran) return;
      ran = true;
      if (mode !== "never") {
        update();
        start.after = rowNames();
        start.titleAfter = dialogTitle();
      }
      resolveDone();
      resolveFinished();
    };
    if (mode === "deferred") queue.push(go);
    else queueMicrotask(go);
    return {
      updateCallbackDone,
      finished,
      skipTransition: () => queueMicrotask(go),
    };
  };
  return {
    starts,
    release: async () => {
      await act(async () => {
        while (queue.length) queue.shift()!();
      });
    },
  };
}

function rowNames(): string[] {
  return Array.from(
    document.querySelectorAll("#section-devices ul > li p[data-device-name]"),
  ).map((p) => p.textContent ?? "");
}

function dialogTitle(): string | null {
  return (
    document.querySelector('[role="dialog"] h2')?.textContent?.trim() ?? null
  );
}

// ── The Devices card ───────────────────────────────────────────────────────────────────────────

const nightfall = license({
  product: "nightfall",
  productName: "Nightfall",
  deviceCount: 2,
});
const MAC = device({ deviceId: "d1", label: "Mara's MacBook Pro" });
const STUDIO = device({
  deviceId: "d2",
  label: "Studio PC",
  platform: "windows",
  lastSeen: NOW_S - DAY,
});
const OLD = device({
  deviceId: "d3",
  label: "Old laptop",
  status: "deauthorized",
});
const TWO = detail(nightfall, { devices: [MAC, STUDIO, OLD] });
/** The Worker's answer after Studio PC is removed: deauthorized, so not using a seat. */
const ONE = detail(nightfall, {
  devices: [MAC, { ...STUDIO, status: "deauthorized" }, OLD],
});

function Card({
  d,
  loading = false,
}: {
  d: PortalLicenseDetail | undefined;
  loading?: boolean;
}): React.ReactElement {
  return (
    <main>
      <h1 tabIndex={-1}>Nightfall</h1>
      <DevicesCard
        productName="Nightfall"
        seatLimit={3}
        emailConfigured
        detail={d}
        loading={loading}
        error={null}
        onRetry={() => undefined}
      />
    </main>
  );
}

function renderCard(d: PortalLicenseDetail | undefined) {
  const client = createPortalQueryClient();
  const wrap = (x: PortalLicenseDetail | undefined, loading = false) => (
    <QueryClientProvider client={client}>
      <Card d={x} loading={loading} />
    </QueryClientProvider>
  );
  const r = render(wrap(d));
  return {
    refetch: (x: PortalLicenseDetail | undefined, loading = false) =>
      r.rerender(wrap(x, loading)),
  };
}

const card = () => screen.getByRole("region", { name: "Devices" });
/** The count's accessible value (CountUp's visually hidden twin). */
const countValue = () =>
  card().querySelector("[data-count-up] .sr-only")?.textContent;

describe("the Devices card: a change to the devices using a seat is one list transition", () => {
  it("captures the old rows, lands the new state inside it, and says the new count", async () => {
    const fake = installFake();
    const { refetch } = renderCard(TWO);
    expect(rowNames()).toEqual(["Mara's MacBook Pro", "Studio PC"]);
    expect(card().className).toMatch(/\bpk-vt-scope\b/);
    refetch(ONE);
    await waitFor(() => expect(fake.starts).toHaveLength(1));
    await waitFor(() => expect(html.dataset.vt).toBeUndefined());
    expect(fake.starts[0]).toMatchObject({
      vt: "list",
      rows: ["Mara's MacBook Pro", "Studio PC"],
      after: ["Mara's MacBook Pro"],
      list: true,
      scope: true,
    });
    // The words carry the change: the count, the meter's name, the seat no longer used.
    expect(countValue()).toBe("1");
    expect(
      within(card()).getByRole("img", { name: "1 of 3 devices in use" }),
    ).toBeTruthy();
    expect(card().textContent).toContain("+2 not using a seat");
    // The visible digits count down to the same number.
    await waitFor(() =>
      expect(
        card().querySelector("[data-count-up] [aria-hidden]")?.textContent,
      ).toBe("1"),
    );
    // The transition's names are gone with it.
    expect(document.querySelector(".pk-vt-list")).toBeNull();
  });

  it("a refetch that changes nothing, or only a device's details, starts nothing and keeps the rows (no replay)", async () => {
    const fake = installFake();
    const { refetch } = renderCard(TWO);
    const row = screen.getByText("Studio PC").closest("li");
    refetch(detail(nightfall, { devices: [MAC, STUDIO, OLD] }));
    refetch(
      detail(nightfall, {
        devices: [MAC, { ...STUDIO, lastSeen: NOW_S, appVersion: "2.0" }, OLD],
      }),
    );
    await act(async () => undefined);
    expect(fake.starts).toEqual([]);
    expect(screen.getByText("Studio PC").closest("li")).toBe(row);
    // A layout change is not a data change either.
    act(() => void window.dispatchEvent(new Event("resize")));
    await act(async () => undefined);
    expect(fake.starts).toEqual([]);
  });

  it("the first load and another licence land at once", async () => {
    const fake = installFake();
    const { refetch } = renderCard(undefined);
    refetch(undefined, true);
    refetch(TWO);
    expect(rowNames()).toEqual(["Mara's MacBook Pro", "Studio PC"]);
    const edu = license({ product: "nightfall", id: "lic_edu" });
    refetch(
      detail(edu, { devices: [device({ deviceId: "e1", label: "Lab" })] }),
    );
    expect(rowNames()).toEqual(["Lab"]);
    await act(async () => undefined);
    expect(fake.starts).toEqual([]);
  });

  for (const variant of ["data-motion", "no API"] as const)
    it(`reaches the same end state at once, with no transition (${variant})`, async () => {
      const fake = variant === "data-motion" ? installFake() : null;
      if (variant === "data-motion") html.dataset.motion = "reduce";
      const { refetch } = renderCard(TWO);
      refetch(ONE);
      // In the same render: no hold, no frame of the old view.
      expect(rowNames()).toEqual(["Mara's MacBook Pro"]);
      expect(countValue()).toBe("1");
      const digits = () =>
        card().querySelector("[data-count-up] [aria-hidden]")?.textContent;
      // Reduced motion swaps the digits at once; without the View Transitions API (motion still
      // allowed) they count, on frame timestamps, to the same number.
      if (variant === "data-motion") expect(digits()).toBe("1");
      else await waitFor(() => expect(digits()).toBe("1"));
      expect(
        within(card()).getByRole("img", { name: "1 of 3 devices in use" }),
      ).toBeTruthy();
      expect(html.dataset.vt).toBeUndefined();
      await act(async () => undefined);
      expect(fake?.starts ?? []).toEqual([]);
    });

  it("a click while the old view is held acts on the live data: the leaving row does nothing, a removal counts from the live seats", async () => {
    mockFetch({
      "DELETE /api/licenses/nightfall/lic_nightfall/devices/d1": {
        ok: true,
        deviceId: "d1",
      },
    });
    const fake = installFake("deferred");
    const { refetch } = renderCard(TWO);
    refetch(ONE);
    await waitFor(() => expect(fake.starts).toHaveLength(1));
    // Held: Studio PC is still on screen for the capture, but it is gone in the live data.
    expect(rowNames()).toEqual(["Mara's MacBook Pro", "Studio PC"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Studio PC" }));
    expect(screen.queryByRole("heading", { name: "Remove Studio PC?" })).toBe(
      null,
    );
    // The MacBook's confirm opens; while held it reads like the rest of the held view.
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Mara's MacBook Pro" }),
    );
    expect(
      screen.getByText(
        "Its seat is free straight away: 1 of 3 devices in use.",
      ),
    ).toBeTruthy();
    // Removing it now leaves no seat in use (live: 1 in use, not the held 2).
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Mara's MacBook Pro" }),
    );
    await waitFor(() =>
      expect(lastAnnouncement()).toBe(
        "Mara's MacBook Pro was removed. 0 of 3 devices in use.",
      ),
    );
    await fake.release();
    expect(rowNames()).toEqual(["Mara's MacBook Pro"]);
    // The open confirm survived the transition (same row element, same state) and now reads
    // from the new view.
    expect(
      screen.getByRole("heading", { name: "Remove Mara's MacBook Pro?" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Its seat is free straight away: 0 of 3 devices in use.",
      ),
    ).toBeTruthy();
  });

  it("lands the newest data, and a transition whose update never ran still lands the rows; the next change still animates (no stuck flag)", async () => {
    const deferred = installFake("deferred");
    const { refetch } = renderCard(TWO);
    refetch(ONE);
    await waitFor(() => expect(deferred.starts).toHaveLength(1));
    // A second refetch during the hold: the update lands the newest data, not the one it began with.
    const none = detail(nightfall, {
      devices: [
        { ...MAC, status: "deauthorized" },
        { ...STUDIO, status: "deauthorized" },
        OLD,
      ],
    });
    refetch(none);
    await deferred.release();
    expect(rowNames()).toEqual([]);
    expect(screen.getByText(/No device is using this license/)).toBeTruthy();

    // A browser that drops the update: the rows land when it finishes.
    const never = installFake("never");
    refetch(TWO);
    await waitFor(() => expect(never.starts).toHaveLength(1));
    await waitFor(() =>
      expect(rowNames()).toEqual(["Mara's MacBook Pro", "Studio PC"]),
    );
    // And the next change starts a transition of its own.
    const auto = installFake();
    refetch(ONE);
    await waitFor(() => expect(auto.starts).toHaveLength(1));
    await waitFor(() => expect(rowNames()).toEqual(["Mara's MacBook Pro"]));
  });
});

describe("the Devices card: Remove opens in place, then frees the seat", () => {
  for (const reduced of [false, true])
    it(`focus to the confirm's heading, back to Remove on Keep it, then to the h1 with the count said (${reduced ? "reduced motion" : "motion"})`, async () => {
      if (reduced) html.dataset.motion = "reduce";
      else installFake();
      mockFetch({
        "DELETE /api/licenses/nightfall/lic_nightfall/devices/d2": {
          ok: true,
          deviceId: "d2",
        },
      });
      renderCard(TWO);
      const panel = document.getElementById("remove-d2")!;
      expect(panel.className).toMatch(/\bpk-expand\b/);
      expect(panel.childElementCount).toBe(0);
      await userEvent.click(
        screen.getByRole("button", { name: "Remove Studio PC" }),
      );
      const heading = screen.getByRole("heading", {
        name: "Remove Studio PC?",
      });
      expect(panel.hasAttribute("data-open")).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(heading));
      await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
      expect(screen.queryByRole("heading", { name: "Remove Studio PC?" })).toBe(
        null,
      );
      expect(panel.hasAttribute("data-open")).toBe(false);
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Remove Studio PC" }),
        ),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Remove Studio PC" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Remove Studio PC" }),
      );
      await waitFor(() =>
        expect(fetchedRequests()).toContain(
          "DELETE /api/licenses/nightfall/lic_nightfall/devices/d2",
        ),
      );
      await waitFor(() =>
        expect(lastAnnouncement()).toBe(
          "Studio PC was removed. 1 of 3 devices in use.",
        ),
      );
      const h1 = screen.getByRole("heading", { level: 1, name: "Nightfall" });
      await waitFor(() => expect(document.activeElement).toBe(h1));
    });

  it("brings the opened confirm into view once it has opened, smoothly or (reduced motion) at once", async () => {
    const calls: ScrollIntoViewOptions[] = [];
    Element.prototype.scrollIntoView = function (
      this: Element,
      o?: ScrollIntoViewOptions,
    ) {
      if (this.id === "remove-d2") calls.push(o ?? {});
    } as typeof Element.prototype.scrollIntoView;
    renderCard(TWO);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Studio PC" }),
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ block: "nearest", behavior: "smooth" });
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    html.dataset.motion = "reduce";
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Studio PC" }),
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ block: "nearest", behavior: "instant" });
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe("the Devices card: overlapping removals", () => {
  /** Every DELETE answers only when the test lets it, in the order the test chooses. */
  function gatedDeletes(): Record<string, () => void> {
    const open: Record<string, () => void> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            const url =
              typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
            const id = url.split("/").pop()!;
            open[id] = () =>
              resolve(
                new Response(JSON.stringify({ ok: true, deviceId: id }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              );
          }),
      ),
    );
    return open;
  }

  /** Confirm Studio PC's removal, then the MacBook's while the first is still in flight. */
  async function removeBoth(open: Record<string, () => void>): Promise<void> {
    for (const name of ["Studio PC", "Mara's MacBook Pro"]) {
      await userEvent.click(
        screen.getByRole("button", { name: `Remove ${name}` }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: `Remove ${name}` }),
      );
    }
    await waitFor(() => expect(Object.keys(open).sort()).toEqual(["d1", "d2"]));
  }

  it("each says the count as it is when it lands, not as it was at its click", async () => {
    const open = gatedDeletes();
    renderCard(TWO);
    await removeBoth(open);
    await act(async () => open.d2!());
    await waitFor(() =>
      expect(lastAnnouncement()).toBe(
        "Studio PC was removed. 1 of 3 devices in use.",
      ),
    );
    // Both were confirmed with two seats in use; the second to land leaves none.
    await act(async () => open.d1!());
    await waitFor(() =>
      expect(lastAnnouncement()).toBe(
        "Mara's MacBook Pro was removed. 0 of 3 devices in use.",
      ),
    );
  });

  it("counts a landed removal once, when the live data already shows it", async () => {
    const open = gatedDeletes();
    const { refetch } = renderCard(TWO);
    await removeBoth(open);
    await act(async () => open.d2!());
    await waitFor(() =>
      expect(lastAnnouncement()).toBe(
        "Studio PC was removed. 1 of 3 devices in use.",
      ),
    );
    // The refetch after the first removal lands before the second does.
    refetch(ONE);
    await act(async () => open.d1!());
    await waitFor(() =>
      expect(lastAnnouncement()).toBe(
        "Mara's MacBook Pro was removed. 0 of 3 devices in use.",
      ),
    );
  });
});

// ── The seat meter ─────────────────────────────────────────────────────────────────────────────

/** A transition the test finishes: stands in for `.pk-seg`'s transform transition. */
function stubAnimations(): { finish: () => Promise<void> } {
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations =
    function (this: HTMLElement) {
      return this.hasAttribute("data-changed") ? [{ finished }] : [];
    };
  return {
    finish: async () => {
      await act(async () => resolve());
    },
  };
}

const segs = (): HTMLElement[] =>
  Array.from(screen.getByRole("img").querySelectorAll<HTMLElement>(".pk-seg"));
const changed = (): number[] =>
  segs()
    .map((s, i) => (s.hasAttribute("data-changed") ? i : -1))
    .filter((i) => i >= 0);

describe("SeatMeter", () => {
  it("pulses only the segment whose seat changed, once, and never on mount or a same-count render", async () => {
    const anim = stubAnimations();
    const { rerender } = render(<SeatMeter inUse={2} limit={3} />);
    expect(segs()).toHaveLength(3);
    expect(changed()).toEqual([]);
    rerender(<SeatMeter inUse={2} limit={3} className="mb-4" />);
    expect(changed()).toEqual([]);
    rerender(<SeatMeter inUse={1} limit={3} />);
    expect(changed()).toEqual([1]);
    expect(segs().map((s) => s.hasAttribute("data-used"))).toEqual([
      true,
      false,
      false,
    ]);
    await anim.finish();
    expect(changed()).toEqual([]);
    // Filling to the limit pulses the two new seats; every used segment turns red.
    rerender(<SeatMeter inUse={3} limit={3} />);
    expect(changed()).toEqual([1, 2]);
    expect(segs().every((s) => s.className.includes("bg-danger"))).toBe(true);
  });

  it("leaves no data-changed behind when nothing animates (reduced motion, jsdom)", () => {
    const { rerender } = render(<SeatMeter inUse={2} limit={3} />);
    rerender(<SeatMeter inUse={1} limit={3} />);
    expect(changed()).toEqual([]);
    html.dataset.motion = "reduce";
    rerender(<SeatMeter inUse={3} limit={3} />);
    expect(changed()).toEqual([]);
  });

  it("the continuous bar draws its share by transform through the CSSOM, never a width class", () => {
    const { rerender } = render(<SeatMeter inUse={5} limit={20} />);
    const fill = screen
      .getByRole("img")
      .querySelector<HTMLElement>("[data-fill]")!;
    expect(fill.className).toMatch(/\bpk-meter-fill\b/);
    expect(fill.className).toMatch(/\bw-full\b/);
    expect(fill.className).not.toMatch(/w-\[/);
    expect(fill.getAttribute("style")).toBe("--pk-meter: 0.25;");
    rerender(<SeatMeter inUse={10} limit={20} />);
    expect(fill.style.getPropertyValue("--pk-meter")).toBe("0.5");
    rerender(<SeatMeter inUse={30} limit={20} />);
    expect(fill.style.getPropertyValue("--pk-meter")).toBe("1");
    expect(fill.className).toMatch(/\bbg-danger\b/);
  });
});

// ── The Activate dialog ────────────────────────────────────────────────────────────────────────

const KEY = "pkey_mossgarden_Q7xZr2Lk9vT3mN8pB1cY4w";
const KEY2 = "pkey_quill_Lm9xT2qVb8sPzK4wNc7dRf";
const MOMENT = `pk-moment:first-activation:${ACCOUNT.id}`;

/** Preview and claim for two keys: each is addable until claimed, then already yours. */
function activateRoutes() {
  const owned: PortalLicenseSummary[] = [];
  const of = (key: string) =>
    key === KEY
      ? license({ product: "mossgarden", productName: "Mossgarden" })
      : license({ product: "quill", productName: "Quill" });
  return signedIn([], {
    "/api/licenses": () => ({ licenses: owned }),
    "/api/library": () => libraryFor(owned),
    "POST /api/activate/preview": (init: RequestInit | undefined) => {
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      const l = of(key);
      const mine = owned.some((o) => o.product === l.product);
      return {
        verdict: mine ? "already_yours" : "addable",
        product: {
          slug: l.product,
          name: l.productName,
          developerName: "Little Fern",
          iconUrl: null,
          headerUrl: null,
        },
        entries: null,
        license: mine ? { id: l.id } : null,
      };
    },
    "POST /api/claim/license-key": (init: RequestInit | undefined) => {
      const { key } = JSON.parse(String(init?.body)) as { key: string };
      const l = of(key);
      if (!owned.some((o) => o.product === l.product)) owned.push(l);
      return { ok: true, license: l };
    },
  });
}

async function openActivate(): Promise<HTMLElement> {
  await userEvent.click(
    await screen.findByRole("button", { name: "Activate license" }),
  );
  return screen.findByRole("dialog", { name: "Activate a license" });
}

async function continueWith(dialog: HTMLElement, key: string): Promise<void> {
  fireEvent.paste(
    within(dialog).getByRole("textbox", { name: "License key" }),
    {
      clipboardData: { getData: () => key },
    },
  );
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Continue" }),
  );
}

/** The success plate's mark in the open dialog. */
const plateMark = () =>
  screen.getByRole("dialog").querySelector<HTMLElement>(".pk-celebration");

describe("the Activate dialog: steps morph, the first add celebrates once", () => {
  it("each step change is one dialog transition over the panel; focus moves once the new step is in", async () => {
    const fake = installFake();
    mockFetch(activateRoutes());
    renderPortal();
    const dialog = await openActivate();
    expect(dialog.className).toMatch(/\bpk-vt-dialog\b/);
    await continueWith(dialog, KEY);
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole("heading", {
          name: "Add Mossgarden to your account?",
        }),
      ),
    );
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Add Mossgarden" }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(done).getByRole("heading", {
          name: "Mossgarden is in your library",
        }),
      ),
    );
    await userEvent.click(
      within(done).getByRole("button", { name: "Activate another" }),
    );
    const field = await screen.findByRole("textbox", { name: "License key" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(fake.starts.map((s) => [s.vt, s.title, s.titleAfter])).toEqual([
      ["dialog", "Activate a license", "Add Mossgarden to your account?"],
      [
        "dialog",
        "Add Mossgarden to your account?",
        "Mossgarden is in your library",
      ],
      ["dialog", "Mossgarden is in your library", "Activate a license"],
    ]);
    await waitFor(() => expect(html.dataset.vt).toBeUndefined());
  });

  it("the first add on an account celebrates; the next add shows the check only", async () => {
    mockFetch(activateRoutes());
    renderPortal();
    let dialog = await openActivate();
    await continueWith(dialog, KEY);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Mossgarden" }),
    );
    await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    expect(plateMark()?.hasAttribute("data-celebrate")).toBe(true);
    expect(plateMark()?.getAttribute("aria-hidden")).toBe("true");
    expect(window.localStorage.getItem(MOMENT)).toBe("1");
    await userEvent.click(
      screen.getByRole("button", { name: "Activate another" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Activate a license" });
    await continueWith(dialog, KEY2);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Quill" }),
    );
    await screen.findByRole("dialog", { name: "Quill is in your library" });
    expect(plateMark()?.hasAttribute("data-celebrate")).toBe(false);
    expect(plateMark()?.hasAttribute("data-static")).toBe(true);
    expect(plateMark()?.querySelector(".pk-burst")).toBeNull();
  });

  it("under reduced motion the first add shows a still check, and the moment is spent all the same", async () => {
    html.dataset.motion = "reduce";
    const fake = installFake();
    mockFetch(activateRoutes());
    renderPortal();
    const dialog = await openActivate();
    await continueWith(dialog, KEY);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Mossgarden" }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    expect(plateMark()?.hasAttribute("data-static")).toBe(true);
    expect(plateMark()?.querySelector(".pk-burst")).toBeNull();
    expect(window.localStorage.getItem(MOMENT)).toBe("1");
    // The same focus as with motion, and no transition started.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(done).getByRole("heading", {
          name: "Mossgarden is in your library",
        }),
      ),
    );
    expect(fake.starts).toEqual([]);
  });

  it("a key that was already yours changed nothing: the plain check, and the moment is kept for a real add", async () => {
    mockFetch(activateRoutes());
    renderPortal();
    let dialog = await openActivate();
    await continueWith(dialog, KEY);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Mossgarden" }),
    );
    await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    window.localStorage.clear();
    await userEvent.click(
      screen.getByRole("button", { name: "Activate another" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Activate a license" });
    await continueWith(dialog, KEY);
    await screen.findByRole("dialog", {
      name: "Mossgarden is already in your library",
    });
    expect(plateMark()).toBeNull();
    expect(
      within(screen.getByRole("dialog")).getByText("In your library"),
    ).toBeTruthy();
    expect(window.localStorage.getItem(MOMENT)).toBeNull();
  });

  it("the moment never replays on a refetch or a layout change: same element, no new sparks", async () => {
    mockFetch(activateRoutes());
    renderPortal();
    const dialog = await openActivate();
    await continueWith(dialog, KEY);
    const before = fetchedRequests().filter(
      (r) => r === "GET /api/licenses",
    ).length;
    await userEvent.click(
      await screen.findByRole("button", { name: "Add Mossgarden" }),
    );
    await screen.findByRole("dialog", {
      name: "Mossgarden is in your library",
    });
    const mark = plateMark()!;
    expect(mark.hasAttribute("data-celebrate")).toBe(true);
    // The claim refetches the licences; the Done step re-renders with them.
    await waitFor(() =>
      expect(
        fetchedRequests().filter((r) => r === "GET /api/licenses").length,
      ).toBeGreaterThan(before),
    );
    await act(async () => undefined);
    act(() => void window.dispatchEvent(new Event("resize")));
    await act(async () => undefined);
    expect(plateMark()).toBe(mark);
    expect(mark.hasAttribute("data-celebrate")).toBe(true);
    expect(mark.querySelector(".pk-burst")).toBeNull();
  });

  it("a step change made while another holds the old step is the one that lands (Back during the add)", async () => {
    const fake = installFake("deferred");
    mockFetch(activateRoutes());
    renderPortal();
    const dialog = await openActivate();
    await continueWith(dialog, KEY);
    await waitFor(() => expect(fake.starts).toHaveLength(1));
    await fake.release();
    const confirm = await screen.findByRole("dialog", {
      name: "Add Mossgarden to your account?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Add Mossgarden" }),
    );
    await waitFor(() => expect(fake.starts).toHaveLength(2));
    // The confirm step is still on screen (held for the capture): Back acts on it.
    expect(dialogTitle()).toBe("Add Mossgarden to your account?");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Back" }),
    );
    await waitFor(() => expect(fake.starts).toHaveLength(3));
    await fake.release();
    await screen.findByRole("dialog", { name: "Activate a license" });
    const field = screen.getByRole("textbox", { name: "License key" });
    await waitFor(() => expect(document.activeElement).toBe(field));
  });
});

// ── FreeDevicePage ─────────────────────────────────────────────────────────────────────────────

const orbit = license({
  product: "orbit-survey",
  productName: "Orbit Survey",
  deviceCount: 2,
});

function orbitProduct(seats: number): PortalProduct {
  const dev = (id: string, label: string, seen: number) => ({
    deviceId: id,
    label,
    platform: "windows",
    arch: "x86_64",
    appVersion: "2.0.3",
    firstSeen: NOW_S - 90 * DAY,
    lastSeen: NOW_S - seen * DAY,
    dormant: false,
  });
  return {
    product: "orbit-survey",
    name: "Orbit Survey",
    developerName: "Parallax Nine",
    tintColor: null,
    website: null,
    iconUrl: null,
    headerUrl: null,
    support: null,
    services: { license: true },
    status: seats >= 2 ? "device_limit" : "active",
    addedAt: NOW_S - 30 * DAY,
    returnTo: { origins: [], schemes: ["orbitsurvey"] },
    licenses: [
      {
        id: orbit.id,
        tier: null,
        status: seats >= 2 ? "device_limit" : "active",
        licenseStatus: "active",
        activatedAt: NOW_S - 30 * DAY,
        expiresAt: null,
        maxOfflineDays: null,
        deviceLimit: 2,
        activeSeatCount: seats,
        deviceCount: seats,
        dormantCount: 0,
        entitlements: [],
        devices:
          seats >= 2
            ? [dev("gaming", "Gaming PC", 1), dev("work", "Work laptop", 41)]
            : [dev("gaming", "Gaming PC", 1)],
      },
    ],
  };
}

describe("FreeDevicePage: the removed device's success draws the check, no sparks", () => {
  for (const reduced of [false, true])
    it(`the check, focus on the success heading, and no replay when the product refetches (${reduced ? "reduced motion" : "motion"})`, async () => {
      if (reduced) html.dataset.motion = "reduce";
      const scrolled: ScrollIntoViewOptions[] = [];
      Element.prototype.scrollIntoView = function (
        this: Element,
        o?: ScrollIntoViewOptions,
      ) {
        if (this.tagName === "H1") scrolled.push(o ?? {});
      } as typeof Element.prototype.scrollIntoView;
      let removed = false;
      mockFetch(
        signedIn([orbit], {
          "/api/products/orbit-survey": () => orbitProduct(removed ? 1 : 2),
          "DELETE /api/licenses/orbit-survey/lic_orbit-survey/devices/work":
            () => {
              removed = true;
              return { ok: true, deviceId: "work" };
            },
        }),
      );
      window.history.replaceState(null, "", "/#/p/orbit-survey/free-device");
      renderPortal();
      await screen.findByRole("heading", {
        level: 1,
        name: "Your license is on 2 of 2 devices",
      });
      const before = fetchedRequests().filter(
        (r) => r === "GET /api/products/orbit-survey",
      ).length;
      await userEvent.click(
        screen.getByRole("button", { name: "Remove Work laptop" }),
      );
      const h1 = await screen.findByRole("heading", {
        level: 1,
        name: "Work laptop was removed",
      });
      await waitFor(() => expect(document.activeElement).toBe(h1));
      expect(scrolled).toEqual([
        { block: "nearest", behavior: reduced ? "instant" : "smooth" },
      ]);
      const mark = h1.querySelector<HTMLElement>(".pk-celebration")!;
      expect(mark.querySelector("svg.pk-check")).toBeTruthy();
      expect(mark.querySelector(".pk-burst")).toBeNull();
      expect(mark.hasAttribute("data-celebrate")).toBe(false);
      expect(lastAnnouncement()).toBe(
        "Work laptop was removed from Orbit Survey",
      );
      // The removal refetches the product; the success stays as it was (the same check).
      await waitFor(() =>
        expect(
          fetchedRequests().filter(
            (r) => r === "GET /api/products/orbit-survey",
          ).length,
        ).toBeGreaterThan(before),
      );
      await act(async () => undefined);
      expect(h1.querySelector(".pk-celebration")).toBe(mark);
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });
});
