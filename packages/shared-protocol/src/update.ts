// @plrs/protocol/update — Update service wire types (spec §4.1).

/** Architectures the appcast can target (`?arch=` on `/update/appcast.xml`). The
 *  unparameterized feed serves `arm64` for continuity with shipped SUFeedURLs. */
export type UpdateArch = "arm64" | "x86_64";
