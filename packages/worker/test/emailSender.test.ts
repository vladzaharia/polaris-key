import { describe, expect, it } from "vitest";
import {
  AUTH_EMAIL_ADDRESS,
  checkSenderAppName,
  foldForReserve,
  LEGACY_EMAIL_ADDRESS,
  passthroughSender,
  PLATFORM_SENDER_NAME,
  platformSender,
  SENDER_APP_NAME_MAX,
  senderAddress,
} from "../src/core/notify/emailSender.js";
import type { Env } from "../src/platform/env.js";
import { KvMock } from "./kvMock.js";
import { makeEnv } from "./seed.js";

// I-18: the "<App> via Polaris Key" sender name and the reserved-name validator (S-16 §5.2
// "Branding", §5.4 item 7). A tenant can neither send as the platform nor break the header.

const env = (): Env => makeEnv(new KvMock(), []);

describe("the sender-name validator", () => {
  it("accepts ordinary product names and canonicalises their whitespace", () => {
    expect(checkSenderAppName("DJ Downloader")).toEqual({
      ok: true,
      name: "DJ Downloader",
    });
    expect(checkSenderAppName("  Lantern   Works ")).toEqual({
      ok: true,
      name: "Lantern Works",
    });
    for (const name of [
      "Baldur's Gate",
      "Portal 2",
      "Portal Knights",
      "Café Racer",
      "スーパーゲーム",
      "Mr. Game, Deluxe",
    ])
      expect(checkSenderAppName(name).ok, name).toBe(true);
  });

  it("refuses every reserved name, however it is disguised", () => {
    for (const name of [
      "Polaris",
      "Polaris Key",
      "Polaris Key Security",
      "polariskey",
      "P0LARIS",
      "P o l a r i s",
      "Pólaris",
      "Pоlaris", // Cyrillic о
      "Polar1s",
      "Po|aris",
      "РOLARIS", // Cyrillic Р
      "plrs",
      "PLRS Team",
      "Portal",
      "console",
      "ADMIN",
      "Admin!",
      "Support",
      "Security",
      "no-reply",
      "Postmaster",
      "Ｐｏｌａｒｉｓ", // full width
    ])
      expect(checkSenderAppName(name), name).toEqual({
        ok: false,
        reason: "reserved",
      });
  });

  it("refuses header-breaking and spoofing characters", () => {
    for (const name of [
      "Acme\r\nBcc: victim@example.com",
      "Acme\nGames",
      "Acme\u0000",
      "Acme\u007f",
      'Acme" <attacker@example.com>',
      "Acme <x>",
      "Acme＜x＞", // full-width brackets fold to < >
      "support@bank.example",
      "Acme\\Games",
      "Acme‮seman", // right-to-left override
      "Ac​me", // zero-width space
      "Acme Games", // line separator
      "Acme﻿",
    ])
      expect(checkSenderAppName(name), JSON.stringify(name)).toEqual({
        ok: false,
        reason: "forbidden_character",
      });
  });

  it("refuses empty, non-string and over-long names", () => {
    expect(checkSenderAppName("")).toEqual({ ok: false, reason: "empty" });
    expect(checkSenderAppName("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkSenderAppName(null)).toEqual({ ok: false, reason: "empty" });
    expect(checkSenderAppName(42)).toEqual({ ok: false, reason: "empty" });
    expect(checkSenderAppName("a".repeat(SENDER_APP_NAME_MAX)).ok).toBe(true);
    expect(checkSenderAppName("a".repeat(SENDER_APP_NAME_MAX + 1))).toEqual({
      ok: false,
      reason: "too_long",
    });
    // Code points, not UTF-16 units: 40 astral characters still fit.
    expect(checkSenderAppName("🎮".repeat(SENDER_APP_NAME_MAX)).ok).toBe(true);
  });

  it("folds look-alikes for the comparison only", () => {
    expect(foldForReserve("Pоl4r1s")).toBe(foldForReserve("polaris"));
    expect(foldForReserve("P|arls")).toBe(foldForReserve("plaris"));
    expect(foldForReserve("Portal 2")).toBe(`${foldForReserve("portal")}2`);
  });
});

describe("the sender identities", () => {
  it("platform mail is exactly 'Polaris Key', never ' via'", () => {
    expect(platformSender(env())).toEqual({
      name: PLATFORM_SENDER_NAME,
      email: LEGACY_EMAIL_ADDRESS,
    });
    expect(PLATFORM_SENDER_NAME).toBe("Polaris Key");
  });

  it("passthrough mail is '<App> via Polaris Key' with the fixed suffix", () => {
    const e = env();
    e.EMAIL_SENDER_ADDRESS = AUTH_EMAIL_ADDRESS;
    expect(passthroughSender(e, "  Lantern  Works ", "lantern")).toEqual({
      name: "Lantern Works via Polaris Key",
      email: "noreply@auth.plrs.im",
    });
  });

  it("a refused display name falls back to the slug, never to the platform's name", () => {
    const e = env();
    expect(passthroughSender(e, "Polaris Key Security", "acme")?.name).toBe(
      "acme via Polaris Key",
    );
    expect(passthroughSender(e, "Acme\r\nBcc: x@y.z", "acme")?.name).toBe(
      "acme via Polaris Key",
    );
    expect(passthroughSender(e, null, "acme")?.name).toBe(
      "acme via Polaris Key",
    );
    expect(passthroughSender(e, "Polaris", "polaris-tools")).toBeNull();
  });

  it("the address: EMAIL_SENDER_ADDRESS, else PORTAL_EMAIL_FROM's address, else the legacy one", () => {
    const e = env();
    expect(senderAddress(e)).toBe(LEGACY_EMAIL_ADDRESS);
    e.PORTAL_EMAIL_FROM = "Anything Else <Mail@Example.com>";
    expect(senderAddress(e)).toBe("mail@example.com");
    e.EMAIL_SENDER_ADDRESS = "noreply@auth.plrs.im";
    expect(senderAddress(e)).toBe("noreply@auth.plrs.im");
    // A display part or junk in the address var is not an address.
    e.EMAIL_SENDER_ADDRESS = "Evil <noreply@auth.plrs.im>";
    expect(senderAddress(e)).toBe("mail@example.com");
    // Only the address of PORTAL_EMAIL_FROM is honoured, never its name.
    expect(platformSender(e).name).toBe("Polaris Key");
  });
});

describe("mixed-script names", () => {
  it("refuses Latin mixed with a look-alike script", () => {
    expect(checkSenderAppName("Acme Рay")).toEqual({
      ok: false,
      reason: "forbidden_character",
    });
    expect(checkSenderAppName("Acme Pay").ok).toBe(true);
  });
});
