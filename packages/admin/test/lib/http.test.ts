import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpClient,
  HttpError,
  parseRefusal,
} from "../../src/lib/http.js";

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers });

let token = "tok";
function client(over: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return createHttpClient({
    csrfHeader: "X-Test-CSRF",
    csrf: () => token,
    ...over,
  });
}

function stub(...responses: (Response | Error | DOMException)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (!(next instanceof Response)) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function sent(fn: ReturnType<typeof stub>, i = 0) {
  const [path, init] = fn.mock.calls[i] as unknown as [string, RequestInit];
  return { path, init, headers: new Headers(init.headers) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  token = "tok";
});

describe("parseRefusal", () => {
  it("nested and flat bodies give the same fields", () => {
    const fields = ["name"];
    const nested = parseRefusal(400, {
      error: {
        code: "invalid_field",
        message: "Bad name",
        fields,
        errors: ["e1"],
        reason: "too_long",
        area: "settings",
      },
      retryAfter: 7,
    });
    const flat = parseRefusal(400, {
      error: "invalid_field",
      message: "Bad name",
      fields,
      errors: ["e1"],
      reason: "too_long",
      retryAfter: 7,
    });
    for (const e of [nested, flat]) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e).toMatchObject({
        status: 400,
        code: "invalid_field",
        message: "Bad name",
        fields,
        errors: ["e1"],
        reason: "too_long",
        retryAfter: 7,
      });
    }
    expect(nested.area).toBe("settings");
  });

  it("a flat body can carry code beside a nested error object", () => {
    expect(parseRefusal(409, { error: {}, code: "conflict" }).code).toBe(
      "conflict",
    );
  });

  it("reads triesLeft and stale and ignores wrongly typed fields", () => {
    const e = parseRefusal(403, {
      error: "step_up_required",
      triesLeft: 2,
      stale: ["started", 4, "other"],
      retryAfter: "soon",
      fields: "name",
    });
    expect(e).toMatchObject({ triesLeft: 2, stale: ["started", "other"] });
    expect(e.retryAfter).toBeUndefined();
    expect(e.fields).toBeUndefined();
  });

  it("a body that is not an object keeps the status message", () => {
    for (const body of [undefined, null, "oops", ["x"]]) {
      const e = parseRefusal(502, body);
      expect(e.status).toBe(502);
      expect(e.message).toBe("http 502");
      expect(e.code).toBeUndefined();
      expect(e.body).toBe(body);
    }
  });

  it("body keeps route extras", () => {
    const e = parseRefusal(409, {
      error: "feed_in_use",
      packageFeeds: ["a", "b"],
      next: { kind: "sso" },
    });
    expect(e.body).toMatchObject({
      packageFeeds: ["a", "b"],
      next: { kind: "sso" },
    });
  });
});

describe("send", () => {
  it("a non-JSON refusal is an HttpError with the status and no code", async () => {
    stub(new Response("<html>bad gateway</html>", { status: 502 }));
    const e = await client()
      .send("/x")
      .catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 502, message: "http 502" });
    expect(e.code).toBeUndefined();
    expect(e.body).toBeUndefined();
  });

  it("a fetch failure is status 0 and code network", async () => {
    stub(new TypeError("Failed to fetch"));
    const e = await client()
      .send("/x")
      .catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 0, code: "network" });
  });

  it("a caller's AbortError is rethrown as is", async () => {
    const abort = new DOMException("aborted", "AbortError");
    stub(abort);
    await expect(client().send("/x")).rejects.toBe(abort);
  });

  it("sends CSRF only on writes", async () => {
    const fn = stub(json({}), json({}), json({}), json({}));
    const c = client();
    await c.send("/r");
    await c.send("/r", { method: "GET" });
    await c.send("/w", { method: "POST", body: "{}" });
    await c.send("/w", { method: "DELETE" });
    expect(sent(fn, 0).headers.has("X-Test-CSRF")).toBe(false);
    expect(sent(fn, 1).headers.has("X-Test-CSRF")).toBe(false);
    expect(sent(fn, 2).headers.get("X-Test-CSRF")).toBe("tok");
    expect(sent(fn, 3).headers.get("X-Test-CSRF")).toBe("tok");
  });

  it("reads the token at each request", async () => {
    const fn = stub(json({}), json({}));
    const c = client();
    await c.send("/w", { method: "POST" });
    token = "next";
    await c.send("/w", { method: "POST" });
    expect(sent(fn, 0).headers.get("X-Test-CSRF")).toBe("tok");
    expect(sent(fn, 1).headers.get("X-Test-CSRF")).toBe("next");
  });

  it("csrf: true opts a GET in and csrf: false opts a write out", async () => {
    const fn = stub(json({}), json({}));
    const c = client();
    await c.send("/download", {}, { csrf: true });
    await c.send("/logout", { method: "POST" }, { csrf: false });
    expect(sent(fn, 0).headers.get("X-Test-CSRF")).toBe("tok");
    expect(sent(fn, 1).headers.has("X-Test-CSRF")).toBe(false);
  });

  it("sets a JSON content type on a write body unless the caller set one", async () => {
    const fn = stub(json({}), json({}), json({}));
    const c = client();
    await c.send("/w", { method: "POST", body: "{}" });
    await c.send("/w", {
      method: "PUT",
      body: new Blob(["x"]),
      headers: { "Content-Type": "image/png" },
    });
    await c.send("/w", { method: "POST" });
    expect(sent(fn, 0).headers.get("Content-Type")).toBe("application/json");
    expect(sent(fn, 1).headers.get("Content-Type")).toBe("image/png");
    expect(sent(fn, 2).headers.has("Content-Type")).toBe(false);
  });

  it("sends same-origin credentials", async () => {
    const fn = stub(json({}));
    await client().send("/x");
    expect(sent(fn).init.credentials).toBe("same-origin");
  });

  it("raw returns the Response whatever its status", async () => {
    const redirect = new Response(null, { status: 500 });
    const fn = stub(redirect, json({ error: "gone" }, 404));
    const c = client();
    expect(
      await c.send(
        "/logout",
        { method: "POST", redirect: "manual" },
        { raw: true, csrf: false },
      ),
    ).toBe(redirect);
    expect((await c.send("/x", {}, { raw: true })).status).toBe(404);
    expect(sent(fn, 0).init.redirect).toBe("manual");
  });

  it("raw still reports a network failure", async () => {
    stub(new TypeError("offline"));
    const e = await client()
      .send("/logout", {}, { raw: true })
      .catch((x) => x);
    expect(e).toMatchObject({ status: 0, code: "network" });
  });
});

describe("call and callText", () => {
  it("parses JSON, and an empty or 204 body is undefined", async () => {
    stub(
      json({ a: 1 }),
      new Response(null, { status: 204 }),
      new Response("", { status: 200 }),
    );
    const c = client();
    expect(await c.call("/x")).toEqual({ a: 1 });
    expect(await c.call("/x", { method: "DELETE" })).toBeUndefined();
    expect(await c.call("/x")).toBeUndefined();
  });

  it("callText returns the body as text and throws on a refusal", async () => {
    stub(
      new Response("a,b\n1,2\n"),
      json({ error: "no_access", area: "license" }, 403),
    );
    const c = client();
    expect(await c.callText("/report.csv")).toBe("a,b\n1,2\n");
    await expect(c.callText("/report.csv")).rejects.toMatchObject({
      status: 403,
      code: "no_access",
      area: "license",
    });
  });
});

describe("hooks", () => {
  it("onUnauthorized can retry once and never loops", async () => {
    const fn = stub(json({}, 401), json({ ok: true }));
    const onUnauthorized = vi.fn(
      async (_res: Response, retry: () => Promise<Response>) => retry(),
    );
    const c = client({ onUnauthorized });
    expect(await c.call("/me")).toEqual({ ok: true });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a retry that is refused again throws without a second hook call", async () => {
    const fn = stub(json({}, 401), json({ error: "unauthorized" }, 401));
    const onUnauthorized = vi.fn(
      async (_res: Response, retry: () => Promise<Response>) => retry(),
    );
    const e = await client({ onUnauthorized })
      .send("/me")
      .catch((x) => x);
    expect(e).toMatchObject({ status: 401, code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a hook that returns nothing lets the 401 throw", async () => {
    stub(json({ error: "unauthorized" }, 401, { "X-PKey-Session": "expired" }));
    const seen: string[] = [];
    const onUnauthorized = vi.fn((res: Response) => {
      seen.push(res.headers.get("X-PKey-Session") ?? "");
    });
    const e = await client({ onUnauthorized })
      .send("/me")
      .catch((x) => x);
    expect(e).toMatchObject({ status: 401 });
    expect(seen).toEqual(["expired"]);
  });

  it("onUnauthorized does not run for other statuses or for raw", async () => {
    stub(json({ error: "x" }, 403), json({}, 401));
    const onUnauthorized = vi.fn();
    const c = client({ onUnauthorized });
    await c.send("/x").catch(() => undefined);
    await c.send("/x", {}, { raw: true });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("onRefusal sees a 403 step_up_required before the throw, with the call's options", async () => {
    stub(json({ error: "step_up_required", stale: ["started"] }, 403));
    const order: string[] = [];
    const c = createHttpClient<{ stepUpRedirect?: boolean }>({
      csrfHeader: "X-Test-CSRF",
      csrf: () => token,
      onRefusal: (error, opts) => {
        order.push(
          `refusal:${error.status}:${error.code}:${String(opts.stepUpRedirect)}`,
        );
      },
    });
    await c
      .send("/x", { method: "POST" }, { stepUpRedirect: true })
      .catch(() => {
        order.push("thrown");
      });
    expect(order).toEqual(["refusal:403:step_up_required:true", "thrown"]);
  });

  it("onRefusal does not run on success or a network failure", async () => {
    stub(json({}), new TypeError("offline"));
    const onRefusal = vi.fn();
    const c = client({ onRefusal });
    await c.send("/x");
    await c.send("/x").catch(() => undefined);
    expect(onRefusal).not.toHaveBeenCalled();
  });
});
