---
title: "Accounts and recovery"
description: "The Polaris Locker account behind every sign-in: what works without Identity, sign-in methods and where each reaches, joining two accounts, recovery and deletion."
type: "concept"
status: "shipped"
lastReviewed: "2026-11-11"
sidebar:
  order: 6
---

A Polaris Locker account is one person across every product. Your product never sees the account. It sees a pairwise subject (`ps_…`): a random id the person has for your product only. Another product sees a different one.

## The account and the Sign-in feature

The account belongs to the platform. It is always there, and no product turns it on or off. Sign-in (the Identity service) is per product: it decides whether your app can sign a person in.

|                                                      | Identity off                                                      | Identity on                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Your licenses join accounts                          | In Polaris Locker: **Activate license**, the library and Discover | The same, and by signing in to your app                                                                       |
| Your app signs people in                             | No                                                                | Device code, web and native redirect, [automatic sign-in](/docs/features/sign-in/automatic/), nearby approval |
| Key entry                                            | Unlimited and never counted                                       | Counted per license; see [Key entries](/docs/features/licensing/activation/#key-entries)                      |
| **Core → Users**                                     | The people who hold your licenses                                 | The same, with their sign-ins to your product                                                                 |
| Account overrides (Managed config)                   | Reach devices activated with a key of a license the person holds  | Also reach every device signed in to the account                                                              |
| Sign in with your product, Cloud Sync, Cloud Connect | Unavailable                                                       | Can be turned on                                                                                              |

Without Identity a key is your app's only way in, so key entry is never limited.

## Sign-in methods

A person signs in to their account with any of its methods:

- an email code or link;
- a passkey, once the account has a verified email;
- Google, Apple or Steam, where the operator set them up;
- a work or school connection, which takes over for its verified domain. An enforced domain refuses email codes.

Every method follows the same rules:

- **Credentials go only into the Polaris Locker sign-in card.** Your app never asks for an email code or a passkey. A native app opens the card in the system browser, never a web view; see [Native redirect](/docs/features/sign-in/native-redirect/). A device with no browser shows a code or asks a nearby device.
- **One method belongs to one account.** A method already on another account is refused with `link_conflict`. The person signs in to that account instead, or joins the two.
- **The last method stays.** Removing it is refused, so an account always has a way in.
- **Changes need a recent sign-in.** Adding or removing a method needs a sign-in from the last 5 minutes, and emails every verified address on the account.
- **The person agrees to your app.** The first time an account signs in to your app, the person sees what your app gets and confirms.

## Where a method reaches

A method added on the sign-in card signs in to every product. A method your app links may reach only the products that declare the same value: Apple, Game Center and Play Games give each developer its own id for a person, and a Google link reaches everywhere only when its address is proven.

| Method                                      | Signs in to                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email, passkey, a work or school connection | Every product                                                                                                                                             |
| Google, Apple or Steam on the sign-in card  | Every product                                                                                                                                             |
| Google linked from your app                 | Every product when Google vouches for the address and it is already verified on the account; otherwise the products with the same `google.serverClientId` |
| Apple linked from your app                  | The products with the same Apple `teamId`                                                                                                                 |
| Game Center                                 | The products with the same Apple `teamId`                                                                                                                 |
| Play Games                                  | The products with the same `playGames.applicationId`                                                                                                      |

A Google link that reaches every product also signs in through your app's [automatic sign-in](/docs/features/sign-in/automatic/). An Apple link from the sign-in card doesn't: Apple gives your team a different id for the same person. A link that reaches only your products carries no verified email, so it brings no licenses and joins no account.

A player who used Game Center in another developer's game has no link in yours. Their first sign-in goes through the regular sign-in, and your app can then offer to link Game Center, so the next launch is automatic.

Changing `apple.teamId`, `playGames.applicationId` or `google.serverClientId`, or deleting the product, removes the links made under the old value, unless another product still declares it. People sign in the regular way once more. The values are set in [Platform sign-in setup](/docs/features/sign-in/platform-setup/).

## Joining two accounts

A person can end up with two accounts, for example one from Steam and one from an email. They join them under **Account → Sign-in methods → Link an existing account** in Polaris Locker, or when the sign-in card finds their email on another account.

- **Proof of both.** The person signs in to both accounts in the same browser. Two accounts never join because they share an email.
- **Your records still resolve.** The account they keep keeps its pairwise subject for your product. The other subject becomes an alias of it, the user record shows **Merged from**, and your user events get `subject.merged` with both ids.
- **Undo.** The person can undo a join for 72 hours.

## Recovery

Polaris Key runs no recovery desk. Nobody at Polaris Key can open an account, change its methods or move what is in it.

1. A person who can't sign in uses any other method still on the account. A Steam-only account recovers by signing in with Steam again.
2. With no method left, the account is lost. The person makes a new account.
3. They ask your support for their license. You decide on your own evidence, such as a receipt or the buyer email, and move it to the new account with **Reassign…** on the license, or **Relink…** on the person's record under **Core → Users**. The console's Help a customer page has the steps.

Recommend a passkey and a second method, so one lost email account doesn't lock a person out.

## Deletion

A person can delete their account, or remove their data from your product alone.

- **Account deletion** runs 14 days after the request, and the person can cancel it until then. It removes the sign-in methods, sessions and what Polaris Key holds for the person in every product: account overrides and Cloud Sync data. The pairwise subject goes too.
- **Licenses are detached, not deleted.** Each becomes floating. The buyer name and email you set on it stay yours to keep or delete.
- **You hear of it.** Your user events get `subject.deleted` with the subject and your product's license ids, and `detached` says whether they left the account.
- **Removing one product's data** deletes what Polaris Key holds for the person in that product and the pairwise subject. The license stays in their library unless they remove it too.

The admin API lists your user events at `/manage/api/products/<slug>/users/events`, oldest first, 100 at a time; pass the last `cursor` to resume. What is kept, and for how long, is in [What apps collect](/docs/reference/what-apps-collect/).

## Next steps

- [Polaris Locker](/docs/features/sign-in/customer-portal/): the account surface people use.
- [Key entries](/docs/features/licensing/activation/#key-entries): the limit and its refusals.
- [Platform sign-in setup](/docs/features/sign-in/platform-setup/): the Google, Apple, Game Center and Play Games values.
