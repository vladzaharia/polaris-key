---
title: "Members"
description: "Who can sign in to the console: invite people, change or take back their roles, and what happens to an invite when the person signs in."
type: "reference"
lastReviewed: "2026-10-28"
sidebar:
  order: 4
---

A **member** is anyone who holds at least one role in Polaris Key. **Platform → Members** lists
everyone with a role, where each role came from, who gave it, and the open invites. Only a
Superadmin or a Platform admin can open it. A Product admin who holds the Members area of a product
sees the same for that product under **Product → Settings → Members**: the people with a role
there, its open invites, and, read-only, the Superadmins and all-products admins who reach it from
above. What each role can do is on [Roles](/docs/reference/roles/).

## Invite people

Choose **Invite people**, add one or more email addresses (up to 20 at a time), pick a role, and
for a Product admin choose the product (or all products) and the areas. The drawer shows what happens
before you send: who is told, and when the invite expires.

- You can give a role only if you could take it back. A Product admin gives Product admin on their
  own product, up to the areas they hold. A Platform admin gives Console access. Only a Superadmin
  gives Superadmin, Platform admin or Product admin on all products.
- You cannot give yourself a role, or invite an address that belongs to your own account.
- Giving a Superadmin, Platform admin or all-products role asks you to confirm and to step up (sign
  in again with a passkey or your identity provider).
- Every Superadmin is told about each grant. Nothing is added to the person's account until they
  accept.

The invitee gets an email from Polaris Key with a link to the console sign-in. The link carries only
the address, so a forwarded email gives nothing to whoever receives it. If email is off or the
message could not be sent, the drawer shows the link to pass on yourself.

## How an invite converts

An invite is a role waiting on an email address. It becomes a real role the first time the person
signs in to the console **with that address, verified**, and not before:

1. The person opens the link, or any console sign-in, and signs in with a method that proves the
   address.
2. Polaris Key finds the invite for that address, checks it has not expired (7 days) and that the
   person who sent it still holds the power to give that role.
3. The role is added to the person's account, the invite is deleted, and the inviter and every
   Superadmin are told.

An invite for a platform role or for Product admin on all products converts only when the person
signs in through your organization's identity provider, never with a passkey alone.

If the address already belongs to someone who holds a role, no invite is needed: the new role is
added at once and the drawer says **Updated**. An invite that fails a check stays as it is and
the person is not admitted; the sign-in page does not say why.

## Edit roles

Open a member's row menu and choose **Edit roles…**. You can add a role, change its areas, or take
it away. Changes that give more (a new role, a wider area list, **all areas**) need a step-up;
narrowing or removing does not. The same limits apply as when inviting, and a Superadmin's or
Platform admin's role can be changed only by a Superadmin. Roles come from three places, and the
**Access from** column says which: someone added it, the person created the product, or the root
rule.

## Remove someone

**Remove from console…** takes back every role you are allowed to take back. The person can no
longer open the console, and a session they have open stops working within 30 seconds. Every
Superadmin is told. If you can remove only some of their roles, the dialog says so and the rest
stay.

A person in the **root rule** (the platform admin group at your identity provider) cannot be
removed here: take them out of the group instead.

To withdraw an invite before it is used, open its row and choose **Revoke invite…**. The link stops
working and you can invite the address again. An unused invite expires after 7 days and is deleted
a week later.

## When the list is cut

The page shows up to 500 members and 500 invites and says when it has cut the list.
