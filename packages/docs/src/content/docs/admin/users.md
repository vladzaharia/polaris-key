---
title: "Users"
description: "A product's users by their per-product id: their licenses, devices, sign-ins and data, export and data deletion, and the relink tool."
sidebar:
  order: 5
---

**Core → Users** lists the people who use this product. Every product has the page, whether or
not Identity is on: licenses of any product attach to a person's Polaris Key account, so a
product that only sells keys still has users, its license owners.

## What a row is

A row is one person **for this product only**. Each person has a separate random id for every
product (`ps_` and 22 characters). Another product sees a different id for the same person, and
nothing on this page links the two. The console never shows:

- the person's account id or the sign-in methods on their account;
- their licenses, sessions or data in any other product, or the rest of their library;
- personal details beyond what they agreed to share with this product.

A person appears once they hold a license of this product, have a device signed in with it, or
have signed in to it. Someone who only asked for a support code (see [Relink](#relink-a-license))
stays off the list until one of those happens.

## The list

| Column           | What it shows                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**         | The person's id for this product.                                                                                                                         |
| **Contact**      | The buyer email on their license. With Identity on, the account's own email shows only when the person agreed to share it with this product, and says so. |
| **Licenses**     | Their licenses of this product.                                                                                                                           |
| **Devices**      | Authorized devices on those licenses, or signed in with this person.                                                                                      |
| **Last sign-in** | Only with Identity on: their last sign-in to this product.                                                                                                |
| **First seen**   | When this product first had an id for them.                                                                                                               |

Search matches the start of a user id, an exact license id, or the start of a buyer email. It
never searches account emails, so the page can't be used to find out whether someone has an
account.

## The user record

The record has four tabs:

- **Overview**: contact, name (when shared), the data stored for this person in this product,
  and **Merged from** when two of their accounts were merged (an old id opens this record).
  With Identity on it lists their sign-ins to this product, with the method they used ("Signed
  in with Steam") and never the other methods on their account.
- **Licenses**: their licenses of this product, with **Detach** and **Relink**, and the relink
  history with **Undo** while it is open.
- **Devices**: devices on their licenses, or signed in with them.
- **Activity**: console actions on this person and their licenses.

A **Data** tab joins them on products that run Cloud Sync.

### Account overrides

With Config on, **Overview** also holds the person's **account overrides**: managed config (config
and secret keys) for this person on this product. They reach every device signed in to their
account on the product and the devices of licenses they own that were activated with a key; a
license with no account gets none. Entitlement overrides stay on each license. Values are checked
against the active catalog, secrets are stored sealed and never shown again, and each save is
recorded in **Activity** with the key names. When two accounts merge, the surviving account's
values win and every key both had set is listed in **Activity**. See
[Account overrides](/docs/services/config/management-states/#account-overrides).

### Export and data deletion

**Export JSON** downloads everything this product holds for the person: the record above and
every data store's export. The export is recorded in **Activity**.

**Delete data for this product** empties every data store of this product for the person
(config overrides and Cloud Sync data). It asks you to type `delete`, and it can't be undone. The
person, their licenses and their account stay: a developer can never delete, disable, sign out
or merge an account, or change its sign-in methods. Only the person can, from their account.

### Detach a license

**Detach** takes a license out of the person's library. It becomes unclaimed: devices already
activated keep working, and the next person to add it by its key can claim it, under the
product's claim rules.

### Relink a license

**Relink** moves a license to another person of this product. It is how you help someone who
lost access to the account their license is in, so it carries these safeguards:

1. **Name the target by their user id for this product.** Never by email. The person gets an id
   by signing in to your product, or with **Get a support code** on your product's page in their
   Polaris Key account, and reads it to you.
2. **Sign in again.** Relink needs a console sign-in from the last five minutes. The dialog
   offers **Sign in again** and brings you back to the person afterwards.
3. **Give a reason.** Up to 500 characters, kept with the relink and in **Activity** with the
   before and after.
4. **Both accounts are emailed** before the license moves.
5. **Undo for 72 hours.** While the license still sits where the relink put it, **Undo** on
   either person's record moves it back (another fresh sign-in and a reason). A later relink, a
   detach or an account deletion closes the undo.

An operator who relinks more than five licenses in a day raises an alert in the platform
activity.

### Make floating and Reassign

The same tool has two moves keyed by the license rather than by a person, so they also reach a
license that is still waiting for its email. Both carry the relink safeguards (a sign-in from the
last five minutes, a reason, an email before the change, the 72-hour undo and the daily alert),
plus a typed confirmation: the license's name, or its id when it has no name. Polaris Key checks
the typed value too.

- **Make floating** takes the license off its holder: it leaves the account it is in and loses
  its name and email, so it works for anyone with its key. That account is emailed first and the
  license is never added back to it automatically. Its devices keep running unless you also ask
  to sign them out.
- **Reassign** gives the license to another person by email (and optionally a name). The old
  holder and the new address are emailed first. The license joins the account that has verified
  the new address, or waits until someone signs in with it; the email to the new address never
  says which.

**Undo** within 72 hours puts back the account, the name and the email, while the license still
sits where the move put it. Adding the key to an account, a later change of its email, or the end
of the window closes it.

The routes, for scripts that use the admin session:

| Route                                                                | Body                                           |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| `POST /manage/api/products/<slug>/users/licenses/<id>/make-floating` | `reason`, `confirm`, optional `signOutDevices` |
| `POST /manage/api/products/<slug>/users/licenses/<id>/reassign`      | `email`, optional `name`, `reason`, `confirm`  |
| `GET /manage/api/products/<slug>/users/licenses/<id>/relinks`        | the license's moves, newest first              |
| `POST /manage/api/products/<slug>/users/relinks/<relinkId>/undo`     | `reason`                                       |

## Sign-in settings

With Identity on, **Identity → Sign-in** has a **Sign-in through this product** section:

- **App name**: the name in "_App_ wants you to sign in" when your app sends someone to sign in
  with their Polaris Key account, and in the sender of that sign-in mail. Empty uses the product's
  name. A name containing "Polaris" or "plrs", or one like "Support", "Security" or "Admin", is
  refused.
- **Add by key without the purchase email**: shown here, changed on **Identity → Portal**.
- **App Review guideline 4.8**: a warning while iPhone or iPad devices use the product and it
  offers no native Sign in with Apple.
