import { describe, expect, it } from "vitest";
import {
  emailDnsNames,
  evaluateEmailDns,
  parseTags,
  type EmailDnsRecords,
} from "../src/core/emailDns.js";
import { AUTH_EMAIL_DOMAIN } from "../src/core/emailSender.js";

// I-18: the SPF/DKIM/DMARC check for the auth sending subdomain, on fixture records (no network).
// The "good" fixture is what Cloudflare Email Sending publishes on onboarding, as resolved for
// plrs.im on 2026-10-04 (key shortened).

const good = (): EmailDnsRecords => ({
  bounceMx: [
    "route1.mx.cloudflare.net",
    "route2.mx.cloudflare.net.",
    "route3.mx.cloudflare.net",
  ],
  bounceTxt: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
  dkimTxt: [
    "v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
  ],
  dmarcTxt: ["v=DMARC1; p=reject;"],
});

const failing = (r: EmailDnsRecords): string[] =>
  evaluateEmailDns(AUTH_EMAIL_DOMAIN, r)
    .findings.filter((f) => !f.ok)
    .map((f) => f.check);

describe("the sending-domain DNS check", () => {
  it("names the records Cloudflare Email Sending publishes", () => {
    expect(emailDnsNames("auth.plrs.im")).toEqual({
      bounce: "cf-bounce.auth.plrs.im",
      dkim: "cf-bounce._domainkey.auth.plrs.im",
      dmarc: "_dmarc.auth.plrs.im",
      orgDmarc: "_dmarc.plrs.im",
    });
    expect(emailDnsNames("plrs.im.").orgDmarc).toBeNull();
  });

  it("passes the onboarding records", () => {
    const report = evaluateEmailDns(AUTH_EMAIL_DOMAIN, good());
    expect(report.ok).toBe(true);
    expect(report.findings.map((f) => f.check)).toEqual([
      "bounce_mx",
      "spf",
      "dkim",
      "dmarc",
    ]);
  });

  it("fails while nothing is published", () => {
    expect(
      failing({ bounceMx: [], bounceTxt: [], dkimTxt: [], dmarcTxt: [] }),
    ).toEqual(["bounce_mx", "spf", "dkim", "dmarc"]);
  });

  it("SPF: needs exactly one record with Cloudflare's include and no +all", () => {
    expect(
      failing({ ...good(), bounceTxt: ["v=spf1 include:other.example ~all"] }),
    ).toEqual(["spf"]);
    expect(
      failing({
        ...good(),
        bounceTxt: [
          "v=spf1 include:_spf.mx.cloudflare.net ~all",
          "v=spf1 -all",
        ],
      }),
    ).toEqual(["spf"]);
    expect(
      failing({
        ...good(),
        bounceTxt: ["v=spf1 include:_spf.mx.cloudflare.net +all"],
      }),
    ).toEqual(["spf"]);
    // Unrelated TXT records beside it are fine.
    expect(
      failing({
        ...good(),
        bounceTxt: ["google-site-verification=x", ...good().bounceTxt],
      }),
    ).toEqual([]);
  });

  it("DKIM: a revoked (empty p=) or non-RSA key fails", () => {
    expect(failing({ ...good(), dkimTxt: ["v=DKIM1; k=rsa; p="] })).toEqual([
      "dkim",
    ]);
    expect(
      failing({ ...good(), dkimTxt: ["v=DKIM1; k=ed25519; p=abc"] }),
    ).toEqual(["dkim"]);
  });

  it("DMARC: must enforce, cover all mail and allow relaxed SPF alignment", () => {
    for (const rec of [
      "v=DMARC1; p=none",
      "v=DMARC1; p=quarantine; pct=50",
      "v=DMARC1; p=reject; aspf=s",
    ])
      expect(failing({ ...good(), dmarcTxt: [rec] }), rec).toEqual(["dmarc"]);
    expect(
      failing({
        ...good(),
        dmarcTxt: ["v=DMARC1; p=quarantine; adkim=s; rua=mailto:x@y.z"],
      }),
    ).toEqual([]);
  });

  it("DMARC: inherits the organizational record (its sp=) when the subdomain has none", () => {
    const base = { ...good(), dmarcTxt: [] };
    expect(failing({ ...base, orgDmarcTxt: ["v=DMARC1; p=reject;"] })).toEqual(
      [],
    );
    expect(
      failing({ ...base, orgDmarcTxt: ["v=DMARC1; p=reject; sp=none"] }),
    ).toEqual(["dmarc"]);
    expect(failing({ ...base, orgDmarcTxt: [] })).toEqual(["dmarc"]);
  });

  it("parses tags, first one wins", () => {
    expect(
      parseTags("v=DMARC1; p=reject; p=none; RUA = mailto:a@b").get("p"),
    ).toBe("reject");
    expect(parseTags("v=DMARC1; RUA = mailto:a@b").get("rua")).toBe(
      "mailto:a@b",
    );
  });
});
