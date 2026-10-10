// client-core's proof for product backends (WIRE-CONTRACT-V4 §14, plans/SP-53.md): every row of
// `conformance/corpus/v2/backend-matrix.json`, which the corpus generator recomputed with its own
// reference, then the edges the corpus cannot carry (the Fetch `Headers` form, the option checks,
// the problem's headers and body, the copy fallback).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKEND_LOCALES,
  BACKEND_REFUSAL_STATUS,
  backendHeaderElements,
  backendLocale,
  backendProblem,
  backendVerdict,
  clientBackendAction,
  type BackendCopyTable,
  type BackendLocale,
  type BackendRefusalCode,
  type BackendVerdictInput,
  type ClientBackendInput,
} from "../src/backend.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p: string[]) =>
  JSON.parse(readFileSync(join(ROOT, ...p), "utf8")) as unknown;

const MATRIX = read("conformance", "corpus", "v2", "backend-matrix.json") as {
  backendMatrixVersion: number;
  constants: { locales: string[]; statuses: Record<string, number> };
  verdict: {
    id: string;
    input: BackendVerdictInput & { headers: [string, string][] };
    expect: { status: number; code: string | null; context: unknown };
  }[];
  problem: {
    id: string;
    input: {
      code: BackendRefusalCode;
      acceptLanguage: string | null;
      realm: string;
    };
    expect: Record<string, unknown>;
  }[];
  client: {
    id: string;
    input: ClientBackendInput;
    expect: { action: string };
  }[];
};

const COPY = Object.fromEntries(
  BACKEND_LOCALES.map((l) => [
    l,
    (
      read("conformance", "parity", `copy.${l}.json`) as {
        codes: BackendCopyTable;
      }
    ).codes,
  ]),
) as Record<BackendLocale, BackendCopyTable>;

const byId = (id: string) => MATRIX.verdict.find((r) => r.id === id)!;

describe("backend-matrix.json through client-core (§14)", () => {
  it("is version 1, and its locales and statuses are client-core's", () => {
    expect(MATRIX.backendMatrixVersion).toBe(1);
    expect(MATRIX.constants.locales).toEqual([...BACKEND_LOCALES]);
    expect(MATRIX.constants.statuses).toEqual(BACKEND_REFUSAL_STATUS);
  });

  for (const row of MATRIX.verdict)
    it(`verdict ${row.id}`, async () => {
      const got = await backendVerdict(row.input);
      expect({
        status: got.status,
        code: got.code,
        context: got.context,
      }).toEqual(row.expect);
      // The verified document travels with the context, and only with it.
      expect(got.document === null).toBe(got.context === null);
    });

  for (const row of MATRIX.problem)
    it(`problem ${row.id}`, () => {
      const got = backendProblem(row.input.code, {
        acceptLanguage: row.input.acceptLanguage,
        realm: row.input.realm,
        copy: COPY,
      });
      const { status, locale, challenge, type, title, detail } = got;
      expect({ status, locale, challenge, type, title, detail }).toEqual(
        row.expect,
      );
    });

  for (const row of MATRIX.client)
    it(`client ${row.id}`, () => {
      expect(clientBackendAction(row.input)).toBe(row.expect.action);
    });
});

describe("the edges the corpus cannot carry", () => {
  it("a Fetch Headers gives the verdict of the fields one by one", async () => {
    const ok = byId("ok");
    const jws = ok.input.headers[0]![1];
    // Headers is iterable at run time; this package's `lib` has no DOM.Iterable to say so.
    const fields = (h: Headers) =>
      h as unknown as Iterable<readonly [string, string]>;
    const joined = new Headers();
    joined.append("X-PKey-License", jws);
    joined.append("X-PKey-License", jws);
    // Headers joins the two fields into one value, `<jws>, <jws>`.
    expect([...fields(joined)]).toEqual([["x-pkey-license", `${jws}, ${jws}`]]);
    const twice = await backendVerdict({
      ...ok.input,
      headers: fields(joined),
    });
    expect(twice.code).toBe("license_invalid");
    const single = new Headers({ "x-pkey-license": jws });
    expect(
      (await backendVerdict({ ...ok.input, headers: fields(single) })).status,
    ).toBe(200);
    expect(backendHeaderElements(fields(joined), "X-PKEY-LICENSE")).toEqual([
      jws,
      jws,
    ]);
  });

  it("a product slug that names an inherited member finds no trust set", async () => {
    const ok = byId("ok");
    const got = await backendVerdict({
      ...ok.input,
      options: { products: ["__proto__", "constructor"] },
      trust: {},
    });
    expect(got.code).toBe("license_invalid");
  });

  it("a value of at most 16 384 characters but more bytes is refused at step 2", async () => {
    const ok = byId("ok");
    const value = "é".repeat(9000);
    const got = await backendVerdict({
      ...ok.input,
      headers: [["X-PKey-License", value]],
    });
    expect(got.code).toBe("license_invalid");
  });

  it("refuses invalid options with a TypeError, never a verdict", async () => {
    const ok = byId("ok");
    await expect(
      backendVerdict({ ...ok.input, options: { products: [] } }),
    ).rejects.toThrow(TypeError);
    await expect(
      backendVerdict({
        ...ok.input,
        options: { products: ["djdl"], maxAgeSeconds: -1 },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      backendVerdict({
        ...ok.input,
        options: { products: ["djdl"], maxAgeSeconds: 1.5 },
      }),
    ).rejects.toThrow(TypeError);
    // A null maxAgeSeconds is the document's own window.
    expect(
      (
        await backendVerdict({
          ...ok.input,
          options: { products: ["djdl"], maxAgeSeconds: null },
        })
      ).status,
    ).toBe(200);
  });

  it("the problem's headers and body: no-store, the challenge only on a 401, never the step", () => {
    const stale = backendProblem("license_stale", {
      acceptLanguage: "de",
      realm: "djdl",
      copy: COPY,
    });
    expect(stale.headers).toEqual({
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'PKey-License realm="djdl", error="license_stale"',
    });
    expect(stale.body).toEqual({
      type: "https://key.plrs.im/docs/reference/error-codes/#license_stale",
      title: COPY.de.license_stale!.title,
      status: 401,
      detail: COPY.de.license_stale!.message,
      code: "license_stale",
    });
    expect(Object.keys(stale.body).sort()).toEqual([
      "code",
      "detail",
      "status",
      "title",
      "type",
    ]);
    const forbidden = backendProblem("not_entitled", {
      realm: "djdl",
      copy: COPY,
    });
    expect(forbidden.headers["WWW-Authenticate"]).toBeUndefined();
    expect(forbidden.locale).toBe("en");
  });

  it("a locale whose table lacks the code falls back to English, and says so", () => {
    const got = backendProblem("sign_in_required", {
      acceptLanguage: "ja",
      realm: "djdl",
      copy: { en: COPY.en },
    });
    expect(got.locale).toBe("en");
    expect(got.title).toBe(COPY.en.sign_in_required!.title);
    expect(() =>
      backendProblem("sign_in_required", { realm: "djdl", copy: {} }),
    ).toThrow(TypeError);
  });

  it("locale negotiation: absent, and a range outside ASCII", () => {
    expect(backendLocale(undefined)).toBe("en");
    expect(backendLocale("ＤＥ")).toBe("en");
    expect(backendLocale("İt")).toBe("en");
  });

  it("the client rule treats an absent retried as a first attempt", () => {
    expect(
      clientBackendAction({
        document: null,
        now: 0,
        response: { status: 401, code: "license_stale" },
      }),
    ).toBe("refresh-and-retry");
  });
});
