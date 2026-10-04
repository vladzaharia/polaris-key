---
title: "App Store: Distribute and App Store products"
description: "The console's App Store page (the Distribute flow: build, export compliance, release notes, TestFlight, version, preflight, submit for review, release) and Commerce's App Store products (create, localize, price and make available In-App Purchases)."
sidebar:
  order: 14
---

Two console pages drive a product's App Store app through the
[App Store Connect connector](/docs/services/distribution/app-store-connect/): **Distribution →
App Store** takes a build to TestFlight and the App Store, and **Distribution → Commerce** creates
the In-App Purchases the [commerce bridge](/docs/services/distribution/commerce/) maps to licence
flags. Both act only on the app the product is pinned to, and both are for platform admins.

Every change is one named request to App Store Connect, confirmed before it is sent, and what the
page shows afterwards is App Store Connect's own answer. Each confirmation carries a retry key: if
a step fails halfway or the connection drops, confirming again resumes from what already
happened instead of repeating it.

When the product has no usable App Store Connect connector (no key, no pin, or an outlet that
names no app) both pages say why and link to **Outlet credentials**.

## The App Store page

The page has the **Distribute** flow on the left and, on the right, what App Store Connect has now:
the app's newest versions with their state, and its open review submissions. The step, the build
and the version are kept in the URL, so a refresh or a shared link opens the same place, and an
earlier step that is not finished yet comes first.

1. **Build.** The app's builds that have not expired, newest first, with their processing state,
   when they were uploaded, App Store Connect's upload warnings and errors, and the Polaris Key
   release each one is linked to. A build that is still processing cannot be chosen; the list is
   checked every 10 seconds while one is, and **Check now** checks at once.
2. **Export compliance.** Shown as a question only when the build has no answer yet. App Store
   Connect holds the build for TestFlight and App Review until it has one, and an answer cannot be
   changed through the API afterwards.
3. **Release notes.** One set of notes per locale (up to 4,000 characters each). **Save to
   TestFlight** sets TestFlight's What to Test for the build; the Version step sends the same notes
   to the App Store version's What's New. The notes are kept in the browser tab while you work.
4. **TestFlight.** The build's internal and external testing states, and the app's TestFlight
   groups to tick. Internal groups get the build at once; external groups get it after beta review,
   which **Submit for beta review** requests. Beta review needs the app's Test Information, linked
   from the step.
5. **Version.** Choose the platform and version number: an editable version with that number is
   reused, otherwise App Store Connect creates one. Then attach the build, apply the release notes,
   choose when the approved version is released (after approval, manually, or scheduled for a date
   and time, on the hour) and, optionally, a phased release.
6. **Preflight.** What App Store Connect's API shows about readiness: the build, export
   compliance, screenshots per locale, the age rating, the App Review contact, price, availability
   and, for external testing, the beta review details. App Privacy and an app's first In-App
   Purchase are App Store Connect steps the API cannot check; each line that is not ready links to
   the page in App Store Connect that fixes it.
7. **Submit.** The version goes to App Review together with the In-App Purchases and Background
   Assets that are ready (each can be unticked). Submitting needs the app's name typed exactly as
   App Store Connect shows it; Polaris Key checks it against App Store Connect before anything is
   sent.

Beside each version, **Release…** releases an approved version that waits for a manual release,
and a phased release can be paused, resumed or released to everyone. A review submission that is
with App Review or has unresolved issues can be cancelled. Releasing and releasing to everyone are
typed the same way as submitting, because App Store Connect cannot take a release back. These
controls need the version's build to be linked to a Polaris Key release (the release matching its
version number).

## App Store products in Commerce

One row per App Store product id in the commerce map, with the flag it grants and the deliverable,
beside the product's state in App Store Connect: **Not created**, or App Store Connect's own state
(missing metadata, ready to submit, waiting for review, approved…). A product id that exists in
App Store Connect as another type of purchase is flagged; resolve it there, since a product id can
neither change type nor be reused.

The row actions:

- **Create in App Store…** (a product id that is not created yet): a non-consumable In-App
  Purchase with a reference name, one display name and description per locale (up to ten; 35 and 55
  characters), an optional note for App Review and Family Sharing.
- **Add or edit a locale…**: one locale's display name and description.
- **Set price…**: a price from the list App Store Connect offers in the base territory, effective
  at once; Apple derives every other territory. The first price is a plain confirmation. Changing
  an existing price needs the app's name typed, because once a price increase takes effect it
  cannot be reverted.
- **Make available everywhere…**: every territory, and new ones as Apple adds them, written only
  while the purchase has no availability. It always needs the app's name typed: availability
  decides where the purchase is sold.

Ready purchases go to App Review with the next version from the App Store page. An app's **first**
In-App Purchase is the exception: App Store Connect requires it to be submitted there, with an app
version, and both pages say so until one of the app's purchases has been approved. The review
screenshot is added in App Store Connect too.

## Audit

Every change appears in the product's **Activity** as `distribution.asc.<operation>`, and the
operation's record keeps App Store Connect's state before and after it. Tester emails, contact
details and the demo account are never stored.
