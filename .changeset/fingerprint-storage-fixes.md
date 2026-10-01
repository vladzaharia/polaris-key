---
"@polaris-key/client-core": minor
"@polaris-key/node": minor
---

Fix fingerprint sources and token storage, and surface where the token lives.

**Store status.** `Store` gains an optional `status()` returning `StoreStatus`
(`{ backend, degraded?: { reason, detail? } }`), with the `STORE_BACKENDS` and
`STORE_DEGRADED_REASONS` vocabularies. `PolarisKeyClient.storeStatus()` reports it, and the CLI's
`status` command prints a `Token store:` line. A `KeyringStore` that falls back to its 0600 file
now says so (`keyring-unavailable` or `keyring-error`) instead of doing it silently (security
finding R4-11).

**Keyring.** `@napi-rs/keyring` moves to `^2.1.0`. On Linux every entry is pinned to the Secret
Service: a headless host used to get the in-memory kernel keyring, which lost the token at the
next reboot; it now gets the 0600 file and a `keyring-unavailable` status. Writes are verified by
reading back; reads are file-first, because only a write that fell back leaves a file, so an
older keyring token can no longer shadow a newer file token. A headless Linux host whose token
was in the kernel keyring re-activates once.

**Windows fingerprint.** `boardSerial` and `machineModel` are read with one PowerShell
`Get-CimInstance` call (the same WMI properties `wmic` read, so Windows 10 sees no drift; Windows
11 without `wmic` regains both). No console window flashes and the child's stdin is the null
device. `parseWindowsCim()` and `WINDOWS_CIM_COMMAND` are exported.

**Linux anchor.** `machineUuid` and the device id read `/etc/machine-id`, else
`/var/lib/dbus/machine-id`, skipping blank and `uninitialized` files. `product_uuid` and
`board_serial` are no longer read, so root and non-root processes agree. A root process on a
host with a machine-id changes two components once (`normal` tolerates it; `strict` re-binds
once). **A host with neither file — most container images — has no anchor**, so keyless
enrolment there answers `fingerprint_required`. In a container, mount the host's
`/etc/machine-id` read-only, or create one and keep it in a volume; never bake one into an
image, because every container of that image would share it. A missing `/etc/machine-id` no
longer mints a random device id when the dbus file exists. `linuxAnchorSource()` is exported.

**`ramBucket`.** Below 1 GiB the component is omitted (it was `"0.5"`). `ramBucket(bytes)` is
exported and integer-exact.

**Directories.** `CoreOptions` gains `dataDir`, `cacheDir` and `stateDir` (bases; the product
slug is appended), with platform defaults, exposed as `core.dirs`. `resolveDirs()` and
`excludeFromBackup()` are exported. The config directory does not move, except that an empty
`XDG_CONFIG_HOME` now means `~/.config` rather than the working directory.
