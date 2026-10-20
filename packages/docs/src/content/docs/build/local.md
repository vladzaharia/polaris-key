---
title: "Run Polaris Key locally"
description: "pkey dev: a local Polaris Key with a seeded product, a test key for every state, a fake sign-in and signed releases, for building and testing without an account."
type: "how-to"
lastReviewed: "2026-10-11"
sidebar:
  order: 6.6
---

`pkey dev` runs the Worker's own router on your machine: no account, no registered product, no
secrets. Refusals are the ones production sends. Nothing outlives the process, and it listens on
loopback only.

## Start it

1. With Node 22.13 or later, run:

   ```sh
   pnpm exec pkey dev
   ```

In a directory with a `.pkey/`, it seeds that product. Anywhere else, or with `--builtin`, it
seeds Tidewater Studio (license, config, sign-in, release, distribution, update). It starts in
under a second and prints the signing and release pins, a license key for each state, and writes
`polaris-key.json` (`--out file`, or `--no-write`).

## Point an SDK at it

```sh
pnpm exec pkey sdk --lang node --dev --write
```

`--dev` takes the product, origin and release keys from the running server (`--url` names it).
Pass the printed keys to `activateWithKey`. Every SDK keeps a non-default base URL's state apart
(`<product>@<host>`), so a dev run never reads or replaces a production token on the same machine.

## Test keys

| Key                 | What the app sees                   |
| ------------------- | ----------------------------------- |
| `ok`                | Activates; `exportPro` entitled     |
| `expired`           | `unauthorized`                      |
| `disabled`          | `unauthorized`                      |
| `revoked`           | `unauthorized`                      |
| `device-limit-full` | `device_limit`                      |
| `key-entry-limit`   | `key_entry_limit`                   |
| `floating`          | Activates; a bulk key in no account |

## Change things while it runs

```sh
pkey dev expire ok            # also: disable, revoke, restore
pkey dev fill-seats ok        # the next device gets device_limit
pkey dev config render.quality '"high"'
pkey dev release 1.2.0 --channel stable
pkey dev offline              # drop requests; `pkey dev online` answers again
pkey dev keys                 # print the test keys
```

A config change reaches the app on its next sync. Signed documents carry whole-second times, so a
change made in the same second as the last sync shows on the one after.

## Sign-in

Device-code and browser sign-in go through a fake identity provider that signs in one person
(Iris Calder). Its page has an Approve button; `--auto-approve` skips it.

## Emulators and simulators

The server answers on `127.0.0.1`, which an emulator does not share with your machine.

- Android emulator: `adb reverse tcp:8787 tcp:8787`, then use `http://127.0.0.1:8787`.
- iOS simulator: shares the host's loopback; use `http://127.0.0.1:8787`.
- A physical device: forward the port over USB (`adb reverse`), or keep the dev run on the
  computer and test there. `pkey dev` does not listen on the network.
- A browser app: the page's `http://localhost` and `http://127.0.0.1` origins on ports 3000,
  4173, 5173 and 8080 are allowed (`web.origins`).

## What it is not

It is the real router over throwaway data, not Polaris Key: no console, no Polaris Locker, and no store
connectors. The keys, pins and users exist only until you stop it.
