/**
 * The Cloud Connect slice of the console API (CC-16.W): the people with linked devices and the
 * relay's usage. Both reads are counters and rosters only: no key, certificate or hardware value.
 */
import { call, enc, p } from "./transport.js";

export interface ConnectDevice {
  deviceId: string;
  label: string | null;
  platform: string | null;
  /** Seconds: when the device's current keys were published. */
  keysSince: number;
  lastSeen: number;
}

export interface ConnectPerson {
  /** The product's pairwise subject (`ps_…`), never the account. */
  subject: string;
  label: string | null;
  ringEpoch: number;
  devices: ConnectDevice[];
}

/** `GET …/connect/people?cursor=&subject=`: 50 people a page, by subject; `subject` is one person. */
export type ConnectPeoplePage =
  | { enabled: false }
  | { enabled: true; people: ConnectPerson[]; nextCursor: string | null };

/** `GET …/connect/usage?days=30`: one row per UTC day, oldest first, zeros filled. */
export type ConnectUsageResponse =
  | { enabled: false }
  | {
      enabled: true;
      days: { day: string; bytes: number; sessions: number }[];
      totals: { bytes: number; sessions: number };
      people: number;
    };

export const connectApi = {
  connectPeople: (
    slug: string,
    cursor?: string | null,
    subject?: string | null,
  ) =>
    call<ConnectPeoplePage>(
      `${p(slug)}/connect/people${
        subject
          ? `?subject=${enc(subject)}`
          : cursor
            ? `?cursor=${enc(cursor)}`
            : ""
      }`,
    ),
  connectUsage: (slug: string, days = 30) =>
    call<ConnectUsageResponse>(`${p(slug)}/connect/usage?days=${days}`),
};
