---
title: "Test your integration"
description: "Check that your app handles each license state, going offline, grace and a skewed clock, against a local Polaris Key."
type: "how-to"
lastReviewed: "2026-10-16"
sidebar:
  order: 7
---

`pkey dev` gives you a license key for every state, so you can see your app react to each one before a customer does. Nothing it creates outlives the process.

**Requires:** Node 22.13 or later, the `pkey` CLI, and an app with an SDK installed. [Your first product](/docs/start/first-product/) sets both up.

## Before you start

- [Run Polaris Key locally](/docs/build/local/) explains `pkey dev` in full.
- Your app needs a way to enter a key and to show its license status. The drop-in kits have both.

## Steps

1. **CLI** Start the local server in your product's repo, or anywhere for the built-in Tidewater Studio.

   ```sh title="Terminal"
   pkey dev
   ```

   You should see the signing pins, a license key for each state, and `polaris-key.json` written.

2. **CLI** In a second terminal, write your SDK's config file from the running server.

   ```sh title="Terminal"
   pkey sdk --lang <lang> --dev --write
   ```

   Replace `<lang>` with `node`, `react`, `python`, `swift`, `kotlin` or `godot`. You should see the file written with the dev server's pins.

3. **App** Activate with each key and compare what the app shows.

   | Key                 | Expect                                           |
   | ------------------- | ------------------------------------------------ |
   | `ok`                | Activates; status `ok`                           |
   | `expired`           | `unauthorized`                                   |
   | `disabled`          | `unauthorized`                                   |
   | `revoked`           | `unauthorized`                                   |
   | `device-limit-full` | `device_limit`                                   |
   | `key-entry-limit`   | `key_entry_limit`                                |
   | `floating`          | Activates; a bulk key that belongs to no account |

   You should see your app's message for each failure, not a blank screen or a crash.

4. **CLI** Change a license while the app runs.

   ```sh title="Terminal"
   pkey dev revoke ok
   ```

   You should see the status become `revoked` after the app's next sync. `pkey dev restore ok` undoes it. `expire`, `disable` and `fill-seats` work the same way.

5. **CLI** Drop every request, as if the network were gone.

   ```sh title="Terminal"
   pkey dev offline
   ```

   You should see the app keep its status and keep running on the cached document. `pkey dev online` answers requests again.

6. **App** Optional: test grace. A signed document expires an hour after it is signed and carries a longer `graceUntil`. With the server offline, set the computer's clock forward past the hour, then restart the app.

   You should see the status `grace` while the clock is before `graceUntil`, and `expired` after it. Set the clock back and go online when you're done.

7. **App** Optional: test a clock set backward. The client never reads a time earlier than the newest signed document it has verified. With the app activated, set the clock back a day and restart it.

   You should see the same status as before. Winding the clock back doesn't revive an expired license or extend grace.

8. **CLI** Optional: push a config value and a release, then sync the app.

   ```sh title="Terminal"
   pkey dev config render.quality '"high"'
   pkey dev release 1.2.0 --channel stable
   ```

   You should see the value in the app after its next sync. A change made in the same second as the last sync shows on the one after.

## Check it works

Every row of the table behaves as written, `revoked` appears without a restart, and the app runs offline on its cached document. Then run:

```sh title="Terminal"
pkey doctor --product <slug>
```

You should see the manifest valid and discovery answering, and the product's services and signing keys listed.

On **Integration**, each feature you use shows **Verified** for the platform you ran. If it says Not seen yet, see [Not seen yet](/docs/build/troubleshooting/#not-seen-yet).

## If it isn't working

- The app talks to production, not the dev server: regenerate the config with `--dev`. A dev run keeps its own state, so it never touches a production token.
- An emulator can't reach `127.0.0.1` on your machine. [Run Polaris Key locally](/docs/build/local/#emulators-and-simulators) has the forwarding.
- [Troubleshoot your integration](/docs/build/troubleshooting/): each status and code.
- [Going offline](/docs/features/licensing/offline/): the three offline depths.

## Next steps

- [Go live](/docs/build/go-live/): pins, signing and CI.
- [Going offline](/docs/features/licensing/offline/): bundles for air-gapped devices.
- [Server-side license checks](/docs/features/licensing/server-verification/): verify the document in your backend.
