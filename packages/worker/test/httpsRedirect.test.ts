// B-157: plain http is never served on a deployed environment: a 308 to https, whichever host,
// before the request is looked at. Off a deployed environment nothing changes.
import { describe, expect, it } from "vitest";
import worker, { httpsRedirect } from "../src/index.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";

describe("plain http on a deployed environment (B-157)", () => {
  const deployed = () => ({
    ...makeEnv(new KvMock(), []),
    PKEY_ENVIRONMENT: "prod",
  });

  it("answers a 308 to the same URL over https, for the API and the customer host", async () => {
    for (const host of ["key.plrs.im", "polaris.locker"]) {
      const res = await worker.fetch(
        new Request(`http://${host}/device?user_code=ABCD-EFGH`, {
          method: "POST",
          body: "secret=1",
        }),
        deployed(),
      );
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(
        `https://${host}/device?user_code=ABCD-EFGH`,
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("");
    }
  });

  it("drops an explicit http port from the target", () => {
    const res = httpsRedirect(
      new Request("http://key.plrs.im:8080/x"),
      deployed(),
    );
    expect(res?.headers.get("location")).toBe("https://key.plrs.im/x");
  });

  it("leaves loopback hosts alone on a deployed environment", () => {
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"])
      expect(
        httpsRedirect(new Request(`http://${host}/x`), deployed()),
      ).toBeNull();
  });

  it("leaves https alone, and leaves a non-deployed environment alone", () => {
    expect(
      httpsRedirect(new Request("https://key.plrs.im/x"), deployed()),
    ).toBeNull();
    expect(
      httpsRedirect(
        new Request("http://localhost/x"),
        makeEnv(new KvMock(), []),
      ),
    ).toBeNull();
  });
});
