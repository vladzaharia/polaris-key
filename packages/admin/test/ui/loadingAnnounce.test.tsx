// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { focusRoute } from "../../src/ui/focusRoute.js";
import { Announcer } from "../../src/ui/LiveRegion.js";
import { useLoadingAnnouncement } from "../../src/ui/loading.js";

const spoken: string[] = [];
vi.mock("../../src/ui/LiveRegion.js", async (orig) => {
  const m = await orig<typeof import("../../src/ui/LiveRegion.js")>();
  return {
    ...m,
    announce: (t: string) => {
      spoken.push(t);
      m.announce(t);
    },
  };
});

function Page({ loading }: { loading: boolean }): React.ReactElement {
  useLoadingAnnouncement("devices", loading);
  return <h1>Devices</h1>;
}

beforeEach(() => {
  vi.useFakeTimers();
  spoken.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("loading announcement vs the page announcement", () => {
  it("navigation: the initial load speaks the page message only", async () => {
    const view = render(
      <>
        <Announcer />
        <Page loading />
      </>,
    );
    const p = focusRoute();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await p;
    view.rerender(
      <>
        <Announcer />
        <Page loading={false} />
      </>,
    );
    expect(spoken.filter((s) => s.includes("loaded"))).toEqual([
      "Devices, page loaded",
    ]);
  });

  it("in-page reload after the page announcement still speaks loaded", async () => {
    const view = render(<Page loading />);
    await act(async () => {
      await focusRoute();
    });
    view.rerender(<Page loading={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    spoken.length = 0;
    view.rerender(<Page loading />);
    view.rerender(<Page loading={false} />);
    expect(spoken).toEqual(["Loading devices…", "Devices loaded"]);
  });
});
