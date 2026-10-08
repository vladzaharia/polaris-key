// What `--live` connects with when no flag or environment variable says otherwise. Replace it
// with the file `pkey sdk --lang node --write` generates for your product: the slug and the
// pinned trust keys (kid → raw Ed25519 public key, base64url). Never paste keys by hand.
export default {
  productSlug: "tidewater",
  trust: {
    pinnedKeys: {} as Record<string, string>,
  },
};
