# Polaris Key Help

> **DRAFT. Not yet reviewed. Do not publish.** Text in `[[OWNER: …]]` still needs the owner's
> input. See `REVIEW-NOTES.md` for where each answer comes from.

## The short version

Most things you can do yourself at **key.plrs.im**: sign in, see your licences, free a device,
or delete your account. Questions about an app itself (how it works, refunds, a licence that
should be there but isn't) go to the company that made the app. For anything about your
Polaris Key account, email [[OWNER: support email]].

---

## How do I sign in?

Go to **key.plrs.im** and pick one:

- **Email:** type your email and choose **Continue**. We send you a 6-digit code and a
  **Sign in** button. Type the code, or press the button in the email. Either works once, for 10
  minutes.
- **Google, Apple or Steam:** choose the logo. You'll go to that company to confirm, then come
  back signed in. These appear only where they're offered.
- **Single sign-on:** if your organisation set it up, choose **Continue with …** and sign in the
  way you do at work.

**Tip:** use the email you bought the app with. Licences bought with that email show up in your
library by themselves.

**Have a licence key instead?** Choose **Have a license key?** on the sign-in page. Enter the key,
sign in, and the licence is added to your account.

## My sign-in code didn't arrive

1. **Wait a minute** and check your spam or junk folder. The email comes from
   **Polaris Key** (`noreply@auth.plrs.im` or `noreply@plrs.im`), with the subject "Your Polaris
   Key code: …".
2. **Check the address.** A typo means the code went somewhere else. Go back and try again.
3. **Send a new code** after 60 seconds. The newest code replaces the old one.
4. **Too many codes?** You can request 5 codes an hour (20 a day) for one address. If you see
   "Too many codes", wait a little and try again.
5. **Too many wrong tries?** A code stops working after 5 wrong entries. After 10 wrong entries in
   an hour, that email is locked for 15 minutes.
6. **"We can't send email right now"** means our email sending is down. Try Google, Apple or Steam
   instead, or try again later.
7. Still nothing? Your email provider may be blocking us, or the address bounced before. Email
   [[OWNER: support email]] from that address and we'll check.

## I used Apple's "Hide My Email"

When you sign in with Apple, Apple lets you hide your real address and gives us a random
`@privaterelay.appleid.com` address that forwards to you.

- **You can still sign in with Apple** whenever you like. That doesn't need email.
- **Right now we can't send email to Apple relay addresses**, so you won't get security notices or
  receipts there. [[OWNER: true until the sending domain is registered with Apple
(`EMAIL_APPLE_RELAY`). Remove this bullet once it is.]]
- If you want email notices, or want your licences bought with your real address to appear, sign
  in with that email address too. [[OWNER: confirm how a person adds a second email today;
Account → Sign-in methods currently shows one email.]]
- If you turn off forwarding or stop using Sign in with Apple in your Apple ID settings, Apple
  tells us. We note it on that sign-in method and in your account history, but we don't remove the
  method: only you can do that.

## I lost my licence key

We keep only a scrambled copy of every key, so **we can't show it to you again**. Here's what you
can do:

- **Sign in to the portal with the email you bought with.** If the licence is linked to your
  account or that email, it's in your library and works without the key. Many apps let you
  activate by signing in instead of typing a key.
- **Look for the original email or receipt** from the developer or store. Search your inbox for
  "pkey\_", which is how every key starts.
- **Ask the developer.** They can issue you a new key or move the licence to your account.
- **Get a new key in the portal:** planned. [[OWNER: "Get a new key" is built on the server but
not yet in the portal (G7). Update this answer when it ships.]]

The portal shows only the start of a key (like `pkey_myapp…`) so it can't be copied off a screen.

## How do I free up a device?

Each licence works on a set number of devices. To make room for a new one:

- **In the portal:** open the licence, find the device under **Devices**, choose **Remove** and
  confirm. The seat is free straight away. Use this when the old machine is gone, sold or broken.
- **In the app:** most apps have a "deactivate" or "sign out of this device" option in their
  settings.
- **Do nothing:** a device that hasn't been used for 90 days frees its seat by itself.

Removing a device signs it out. If you use it again later, it will ask you to activate or sign in
again. We email you whenever a device is removed, so you'll know if it wasn't you.

## How do I remove a product from my library?

You can't do this yourself yet. [[OWNER: no portal option or route exists today
(`removeProductData` has no caller). Update when it ships.]] In the meantime:

- Remove its devices (see above) if you've stopped using it.
- Ask the app's developer to remove the licence from your account, or email
  [[OWNER: support email]].

Removing a product from your library doesn't cancel or refund it. Refunds go through the developer
or the store you bought from.

## How do I delete my account?

1. Sign in at **key.plrs.im**.
2. Open **Account**, then **Your data**.
3. Choose **Delete my account**, type your email to confirm, and choose **Delete my account**
   again.

It happens straight away and can't be undone. We email you a confirmation.

**What gets deleted:** your account, email addresses, sign-in methods, sessions, profile picture
and account history.

**What stays:** your licences. They belong to the developers who sold them, so deleting your
account doesn't cancel them or delete them. If you sign in the same way later, they can come back.
To have a licence erased, ask its developer. Full details are in the
[Privacy Policy](privacy.md#how-to-see-download-or-delete-your-data).

**Want a copy of your data first?** "Download my data" is planned. Until then, email
[[OWNER: privacy email]].

## Something else

- **"Your license key is invalid":** check you copied the whole key, and that it's for this app.
  For safety, every kind of problem with a key shows the same message, so if it still fails, ask
  the developer.
- **"Device limit reached":** free a device (see above).
- **The app wants me to go online:** apps can work offline only for a while. Connect for a few
  seconds and it will check in again.
- **I got a "new device signed in" email I don't recognise:** someone may have your email or
  sign-in account. Change the password on your email or Google/Apple/Steam account, then email us.

## How do I contact support?

- **About an app** (how it works, payments, refunds, a missing licence): contact the app's
  developer. Their contact details are on their website or store page.
- **About your Polaris Key account, sign-in or privacy:** email
  [[OWNER: support email]]. Write from the email address on your account if you can, and tell us
  which app you're using. **Never send us your full licence key**; the first few characters are
  enough. [[OWNER: expected response time.]]
