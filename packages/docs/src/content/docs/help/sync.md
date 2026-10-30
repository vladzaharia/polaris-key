---
title: "Cloud Sync"
description: "How your settings follow you between devices, what its status messages mean, and what happens when your storage is full."
type: "help"
status: "shipped"
lastReviewed: "2026-10-28"
sidebar:
  order: 9
---

Cloud Sync keeps an app's settings in your Polaris Locker account, so your devices agree.

## What you need

You need to be signed in to the app with your Polaris Locker account. A device you added with only a license key keeps its settings on that device. They upload the first time you sign in.

## What syncs

Settings the app marks as yours, such as volume or layout. A setting your developer locked does not sync, and the lock wins on every device. Some apps keep a setting on one kind of device only, such as Windows.

## Unlock sync on a new device

An app can encrypt your synced settings so only your devices read them. A new device then says **Sync is locked** and offers **Unlock sync**. Enter your recovery code and choose **Unlock**. Until then the device keeps its own settings and does not pull yours.

If the app says the code isn't right, check it and try again. A mistyped code is caught before anything is sent. You get five tries a day.

## Your recovery code

The app shows the code once, when you turn encryption on. Save it in a password manager or write it down. Polaris Locker does not keep a copy and cannot show it again. If you are signed in on an unlocked device, choose **New recovery code** there.

**Enter it only in the app.** No one from Polaris Locker or the app's developer asks for it, by email, chat, phone or on a web page. Anyone who asks is trying to read your data. If an email says [recovery started](/docs/help/emails/#recovery-started) and it wasn't you, remove that device under **See your devices**.

## Start over

If you have no unlocked device and no code, nothing can read your old synced data. Choose **Start over** in the app. It makes a new key and a new recovery code, and your current synced data is lost. A device that still has the old key can move it across for 30 days.

Start over is open to any signed-in device on your account, so you get an email, [encryption was reset](/docs/help/emails/#encryption-reset). If it wasn't you, [secure your account](/docs/help/secure-your-account/).

## If your sync key changed

The app says a device set up a new key. Choose **That was me** only if you did. If not, choose **Use recovery code**, then [secure your account](/docs/help/secure-your-account/).

## If a change doesn't arrive

- Your devices pick up changes when the app syncs. Open the app on each device and wait a moment.
- If two devices change the same setting, the later change wins.
- If the developer has paused syncing, your changes stay on the device and send once it resumes.
- If you are over your storage, new changes that add data are refused. Clearing or deleting data always works. Nothing is deleted for you.

## Clear or delete synced data

Sign in at [polaris.locker](https://polaris.locker) and see [Manage your data](/docs/help/manage-your-data/). Deleting your account deletes your synced data.

## Related

- [Remove an app from your library](/docs/help/remove-from-library/)
- [Your data](/docs/help/your-data/)
