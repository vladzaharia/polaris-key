/**
 * core/notify/destinations: with email off, a flow that hands over a link degrades to a copyable
 * link instead of failing (invitations and licence keys build on this, LX-27).
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import type { Env } from "../src/platform/env.js";
import {
  deliverOrLink,
  emailConfigured,
} from "../src/core/notify/destinations.js";
import type { NoticeMessage } from "../src/core/notify/templates.js";

const MESSAGE: NoticeMessage = {
  subject: "You are invited",
  text: "Open the link.",
  html: "<p>Open the link.</p>",
};
const LINK = "https://key.plrs.im/#/invite/abc";

describe("deliverOrLink", () => {
  it("email off: answers the link to copy, sends nothing", async () => {
    const env = makeEnv(new KvMock(), []);
    delete (env as { EMAIL?: unknown }).EMAIL;
    expect(emailConfigured(env)).toBe(false);
    expect(
      await deliverOrLink(
        env,
        makeTestDb(),
        "ada@example.com",
        MESSAGE,
        LINK,
        NOW,
      ),
    ).toEqual({ delivered: false, link: LINK });
  });

  it("no address: answers the link", async () => {
    const env = makeEnv(new KvMock(), []);
    env.EMAIL = { send: async () => {} } as unknown as Env["EMAIL"];
    expect(
      await deliverOrLink(env, makeTestDb(), null, MESSAGE, LINK, NOW),
    ).toEqual({ delivered: false, link: LINK });
  });

  it("email on: mails the message and does not leak the link", async () => {
    const env = makeEnv(new KvMock(), []);
    const sent: unknown[] = [];
    env.EMAIL = {
      send: async (m: unknown) => {
        sent.push(m);
      },
    } as unknown as Env["EMAIL"];
    expect(
      await deliverOrLink(
        env,
        makeTestDb(),
        "ada@example.com",
        MESSAGE,
        LINK,
        NOW,
      ),
    ).toEqual({ delivered: true });
    expect(sent).toHaveLength(1);
  });

  it("a provider error degrades to the link", async () => {
    const env = makeEnv(new KvMock(), []);
    env.EMAIL = {
      send: async () => {
        throw new Error("boom");
      },
    } as unknown as Env["EMAIL"];
    expect(
      await deliverOrLink(
        env,
        makeTestDb(),
        "ada@example.com",
        MESSAGE,
        LINK,
        NOW,
      ),
    ).toEqual({ delivered: false, link: LINK });
  });
});
