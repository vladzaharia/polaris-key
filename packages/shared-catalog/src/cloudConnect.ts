// Cloud Connect's limits and ceilings (plans/CC-01-cloud-connect.md §2.7, §2.9; owner answer Q7).
// ONE source of truth: the Worker's settings registry and relay, the console and every SDK import
// these. Nothing here is product-specific (AGENTS rule 5): a person's relay quota is the
// `pkey.cloudConnect.relayBytes` entitlement a tier, a licence or an add-on sets, and the LAN is
// never metered.

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** The platform's Cloud Connect defaults. */
export const CLOUD_CONNECT_DEFAULTS = {
  /** A person's relay bytes per UTC day when nothing sets `pkey.cloudConnect.relayBytes` (the
   *  `cloudConnect.quota.defaultRelayBytes` setting's default). */
  relayBytesPerDay: 256 * MiB,
  /** A device with no usable licence. */
  unlicensedRelayBytesPerDay: 16 * MiB,
  /** Relay sockets: two per device (a third replaces the oldest) and 32 per room. */
  socketsPerDevice: 2,
  socketsPerRoom: 32,
  /** One relay message: a 64 KiB frame plus its envelope. */
  maxMessageBytes: 65_564,
  /** Messages per second per socket, and the burst the bucket holds. */
  messagesPerSecond: 200,
  messageBurst: 400,
} as const;

/** What no setting, tier or entitlement can raise a limit past. */
export const CLOUD_CONNECT_CEILINGS = {
  perPerson: {
    /** The clamp on a person's relay bytes per UTC day. */
    relayBytesPerDay: 4 * GiB,
  },
  perProduct: {
    /** All people on a product together, per UTC month (the `cloudConnect.ceiling.relayBytes`
     *  setting's default). */
    relayBytesPerMonth: 500 * GiB,
  },
} as const;
