---
title: "Minting offline bundles"
description: "When to mint one, the console dialog, the pkey bundle CLI, and the import-window vs. grace-days distinction."
sidebar:
  order: 9
---

An offline activation bundle is a single signed `pkey-bundle+jws` file that lets a machine which
**never touches the network at all** get the same license and config documents it would
otherwise have fetched. This is the deepest of the three offline modes Polaris Key supports (see
[What is Polaris Key?](/docs/start/) → _Five SDKs, one corpus, and it works offline_): a normal
client is offline-_tolerant_ — it activates online once, then runs from a verified cache with
grace — but a bundle exists for the machine that can't do even that first activation.

## When to reach for this

A broadcast rack on an isolated VLAN, a machine on a ship, an air-gapped edit bay: something that
can't register, can't fetch a license document, and can't be told it's running low on grace. The
app's own offline-activation screen shows a **request code** — 32 characters, the device's own
id, generated on-device — and the flow inverts: a human carries the bytes instead of the network
doing it. An operator reads that code over the phone or off a ticket and mints against it, either
from the console or the CLI, and hands the resulting file back on a USB stick or however it gets
to the machine.

## The console dialog

From a license record, **More actions → Mint offline bundle…**:

| Field                 | Notes                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device ID             | The 32-character request code, pasted exactly. A mistyped code is refused locally as a form error rather than becoming a bundle no machine can import.                                                                                                                                                |
| Grace days            | 1–365, defaulting to the ceiling (365) — this is for the machine least able to come back for a fresh one.                                                                                                                                                                                             |
| Include configuration | Shown only when the product runs Config; ships the signed config document alongside the license document. The checkbox disappears rather than greying out on a product without Config — there's no "reachable but off" state to represent, because the product has no config document to ship at all. |
| License               | Implicit — whichever license record you opened the dialog from. There's no authenticated device on this path to infer one from, so the server requires it explicitly whenever License is enabled.                                                                                                     |

The result shows the bundle id (a ULID) with a copy button, a **Download** button for the
`.pkeybundle` file, and the bundle itself, so it can be copied when a browser refuses to save the
file. The bundle id is worth copying onto a support ticket: it's the audit anchor, and the
importing client reports the same id back on import, so it's the one string that ties a "did this
actually get imported" question to both ends.

The dialog asks you to copy the bundle or confirm you've stored it before Done, as it does for a
minted key, but for a different reason. A key is shown once because the server keeps only its
hash and truly cannot show it again; a bundle is a signed artifact, so nothing is lost by losing
the file, and minting a replacement for the same device costs one more request. The check is
there so the file actually leaves the console before the dialog does.

## The `pkey bundle` CLI

For scripted or headless minting, the `pkey` CLI ships a `bundle` command:

```sh
pkey bundle --product djdl --device <32-char-request-code> --grace-days 30 \
  [--no-config] [--license <id>] [--base-url https://key.plrs.im] [--out file.pkeybundle] [--force]
```

It authenticates the same way the console does — there is no API-token surface yet, so this is
the operator's own browser session, exported by hand:

1. Sign in to the console, open devtools → Application → Cookies, and copy the
   `__Host-pkey_admin` cookie's value.
2. `export PKEY_ADMIN_COOKIE='__Host-pkey_admin=<value>'` in the shell you'll run `pkey bundle`
   in (the bare value works too — the command prefixes the cookie name itself when it sees no
   `=`).

The command then does exactly what the console does under the hood: `GET /manage/api/me` to
read that session's CSRF token, then `POST /manage/api/products/<slug>/bundles` echoing it. It's
a short-lived credential carrying full admin authority — don't commit it, script it into a file,
or export it into a shell other people share.

Everything checkable locally is checked before either network call: the device id against the
same 32-character shape the server enforces, grace-days against the same 1–365 range, and the
output path against an existing file (a mint is an audited, non-free server-side event, so
discovering a name collision _after_ minting would waste one). The default output filename is
`<product>-<first 8 chars of device id>.pkeybundle`; the file **is** the JWS with no trailing
newline, so a naive read hands it straight to a verifier.

## Two different clocks, and why they're not the same number

A minted bundle carries two independent time bounds, and conflating them is the most common way
to misconfigure this flow:

| Bound                             | Set by                                                              | Meaning                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The bundle's own `expiresAt`      | The server, always **30 days** from mint, not operator-configurable | The **import deadline** — how long the file itself may sit on a USB stick before an import is refused outright. |
| The inner documents' `graceUntil` | The operator's **Grace days** field, 1–365                          | The **offline window** the resulting install actually runs on, once imported.                                   |

These are deliberately decoupled, and much of the gap is intentional: the 30-day import window
bounds how long a _stolen bundle file_ is useful to someone who didn't have it at mint time,
while grace days bounds how long the install it creates keeps working once it lands. Making them
equal would mean every 365-day grace also handed out a 365-day replay window for the file itself.
The inner documents' own `expiresAt` (about an hour, same as an online fetch) is correct and
looks strange only until you know why: import verifies them on the same reload profile a cached
document gets, so an hour-old-looking document that's actually weeks old is expected, and its
real outer bound is `graceUntil`, not `expiresAt`.

## Nothing is stored but the audit row

The server never persists the bundle's bytes anywhere. The **only** durable record that a mint
happened is one `bundle.minted` entry in the product's [audit log](/docs/admin/activity/),
naming the bundle id, the device it was bound to, the license (if any), what it carried, and the
grace window. If the file is lost, mint again — the operation is stateless and re-minting costs
nothing the server tracks.

## Reference

- [Licenses & devices](/docs/admin/licenses-and-devices/#minting-an-offline-bundle) — where the
  dialog lives in the console.
- [Offline bundles](/docs/build/wire/bundles/) — the wire-level contract: the `pkey-bundle+jws`
  envelope, its three time bounds in full, and the four ordered refusal steps an importing client
  runs (WIRE-CONTRACT-V3 §7).
- [Activity](/docs/admin/activity/) — the audit log `bundle.minted` lands in.
