---
title: "Get a readable copy of your synced data"
description: "Save a copy of what an app synced in a form you can open, and keep it safe: it isn't encrypted."
type: "help"
status: "shipped"
lastReviewed: "2026-11-10"
sidebar:
  order: 9
---

Some apps can save a copy of your synced data on your device, as a zip file you can open. The app offers it, and you choose where the file goes. Polaris Locker isn't involved and keeps nothing.

## What's in the copy

Your synced settings, records and files, in readable form. A `README.txt` in the zip explains the layout. It's the same layout as **Download synced data** in Polaris Locker, with one difference: that download keeps encrypted data encrypted, and this copy doesn't.

## Keep it safe

The copy is **not encrypted**. Anyone who can open the file can read your data. Keep it somewhere private, don't share it, and delete it when you're done. If the app saves it to a shared place, such as a cloud folder, others with access can read it.

## If something is missing

The copy has what the app's account held when you saved it. A change still waiting to send isn't in it, and the app tells you how many. A file that couldn't be read in full is marked in `data.json` in the zip.

## If it doesn't work

- **You're not signed in.** Sign in to the app with your Polaris Locker account and try again.
- **Sync is locked.** Unlock it first. See [Unlock sync on a new device](/docs/help/sync-new-device/).
- **It's too big.** The app can't make a copy over 4 GB. Remove files you don't need and try again.
- **The device can't save the file.** Free some space or choose another place.
- **It waits.** A large copy can pause while the account's hourly file limit resets. Leave the app open.

## Related

- [Your synced data in Polaris Locker](/docs/help/manage-your-data/#synced-data)
- [Sync Across Devices](/docs/help/sync/)
- [Your data](/docs/help/your-data/)
