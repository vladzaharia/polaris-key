# Polaris Key Privacy Policy

> **DRAFT. Not yet reviewed by a lawyer. Do not publish.** Text in `[[OWNER: …]]` is a decision
> or a fact the owner still has to supply. See `REVIEW-NOTES.md` for the source of every claim.

Last updated: [[OWNER: effective date]]

## The short version

Polaris Key is the service that checks your app licences, keeps track of which devices use them,
delivers app downloads and updates, and signs you in. To do that we keep your email address,
the sign-in methods you connect (Google, Apple, Steam or an email code), your licences, and a
short record of each device that uses them. Device details are scrambled (hashed) on your device
before they reach us, so we never see serial numbers or hardware IDs. We do not sell your data,
we do not show ads, and our websites use no analytics or tracking. You can see your licences and
devices, disconnect devices, and delete your account yourself at any time.

---

## Who we are

Polaris Key is run by [[OWNER: legal entity name, registered address and company number]]. In
this policy "we" and "us" means that company, and "you" means the person using an app or a
website built on Polaris Key.

Polaris Key is a service for app developers. The company that made the app you use (the
**developer**) uses Polaris Key to sell and check licences, deliver downloads and sign people in.
That means two companies handle your data, for different parts of the job:

| Part                                                                                     | Who decides what happens to it | What that means for you                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Your **Polaris Key account**: email, sign-in methods, profile, sessions, your library    | **Us**                         | Ask us about it. This policy covers it fully.                                                              |
| An app's **licences, devices and app data**: what you bought, which devices use it, etc. | **The app's developer**        | We look after it for the developer and follow their instructions. Their privacy policy also applies to it. |

In legal terms: we are the **controller** of your account and a **processor** acting for the
developer for each app's data. [[OWNER: confirm with counsel; the data processing agreement with
developers is still pending legal review.]]

## Which websites and services this covers

- **key.plrs.im**: the customer portal (your account and library), the sign-in page, and the
  developer console.
- **dl.plrs.im**: app downloads and updates.
- **pkg.plrs.im**: private package feeds some developers offer.
- The Polaris Key code built into apps (our "SDKs"), whenever it talks to our servers.

It does not cover the developer's own website, store page or the app's other features. Read the
developer's own privacy policy for those.

---

## What we collect

### When you sign in or create an account

| What                                                                                                                       | Where it comes from                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Your email address                                                                                                         | You type it, or Google or Apple sends it                                                    |
| Your name                                                                                                                  | Google, Apple (first and last name, only the first time) or Steam (your Steam persona name) |
| Your profile picture                                                                                                       | Google or Steam. Apple sends none.                                                          |
| Your birth date, only if you add it, or accept one your organisation's sign-in offers. Optional; never shared with any app | You, or your organisation's sign-in system                                                  |
| An ID for you at Google, Apple or Steam                                                                                    | The provider. For Steam this is your Steam ID number.                                       |
| Whether the provider says your email is verified, and your language setting                                                | The provider                                                                                |
| For "single sign-on" through an organisation: your name, email and the groups you're in                                    | Your organisation's sign-in system                                                          |
| When you signed in, how (email, Google, …) and a rough browser label like "Firefox on Windows"                             | Your browser. We keep the browser family and system only, no version numbers.               |
| The rough place a sign-in was requested from, like "Berlin, Germany"                                                       | Cloudflare works this out from your internet address                                        |
| Which apps you agreed to share your email and name with, and which app terms you accepted                                  | You                                                                                         |

**Sign-in codes.** When you sign in by email, we send a 6-digit code and a sign-in link. We keep
only a scrambled (hashed) copy of the code, never the code itself.

**Profile pictures.** We download a copy of your Google or Steam picture and keep it on our own
storage under a random name. When we show it to you, it comes from us, so Google and Steam don't
learn when it's viewed.

**What we don't take from providers:** we don't ask Google, Apple or Steam for your contacts,
friends, games, purchases or anything else beyond what's listed above. We don't keep the access
token Google gives us.

### When you use a licence in an app

The developer gives us, or you enter, the licence details. The app sends the rest.

| What                                                                                           | Why                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| The licence: product, tier, expiry, and the buyer's name and email if the developer set them   | To know what you're allowed to use                     |
| Your licence key, **scrambled**. We keep a keyed hash, never the key itself.                   | To recognise the key when you enter it again           |
| A device ID: a scrambled code made on your device from its system ID                           | To count your devices against your licence's limit     |
| The device's name, only if you or the app give it one (for example "Sam's laptop")             | So you can tell your devices apart                     |
| Platform and chip type (for example "macOS, arm64"), app version, release channel, SDK version | To send the right update and check version limits      |
| The "user agent" text your app or browser sends with each request                              | Kept on the device record (see "Things to know" below) |
| When the device was first and last seen                                                        | To free seats on devices you no longer use             |

**Hardware fingerprint (desktop and mobile apps, not browsers).** Unless the developer turns it
off, the app reads up to seven hardware details: the system's unique ID, the board serial
number, the processor model and core count, the network card's hardware address, the main disk's
ID, the memory size (rounded) and the machine model. **Each one is scrambled on your device with
a one-way hash before it is sent.** We only ever receive the scrambled values. We can compare
them to notice that a licence moved to different hardware, but we cannot turn them back into a
serial number or address. The hash includes the app's name, so two apps on the same computer get
unrelated values and can't be matched up. On Android we read no hardware serial. Browser apps send
no fingerprint at all.

**Software details.** Each time the app checks in, it sends a short report: the operating system
name and version, processor, memory, the app's runtime, **your language and time zone**, the
settings and features the developer has turned on for you, and whether certain other apps the
developer named are installed (only the ones the developer lists in advance, never a list of
everything you have). Games built with Godot also send the engine version, the graphics card's
name and maker, and where the game was installed from (for example Steam or itch.io).

**Update results.** Apps that update through Polaris Key report what happened to each update:
offered, downloaded, installed, confirmed, rolled back or failed, with a short error code. No
names, no messages, no hardware details.

**What apps never send:** your computer's name, your username, your files, your browsing, your
exact location, a list of your installed apps, or any raw serial number.

### When you buy through an app store

If an app sells licences through the App Store, Google Play or Steam, we keep what we need to
keep that licence honest: a scrambled copy of the store's purchase key, the store's product ID,
the transaction or order ID, and for Steam your Steam ID. Store notifications about refunds and
renewals are kept as the store sends them. They contain product and purchase IDs, not your name,
email or card.

### When you download an app or package

A download link from the portal is single-use and expires after five minutes. We record which
device or account it was issued to until it is used or expires, then delete it. If you create a
package feed token, we keep only a scrambled copy of it, its label and expiry.

### When you contact us

If you email us, we keep your email and what you wrote so we can answer.
[[OWNER: support channel, where messages are stored, and for how long.]]

### Developers and console users

If you work in the Polaris Key console, you sign in through your organisation's sign-in system.
We don't keep a separate console account. Your name, email and ID appear in the audit log next
to every change you make.

---

## Why we collect it

| We use it to                                           | Using                                                               | Legal basis (EU/UK)                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Sign you in and keep you signed in                     | Email, sign-in methods, session record                              | Needed to provide the service you asked for                              |
| Check your licence and enforce device limits           | Licence, scrambled key, device ID, fingerprint                      | Needed to provide the service (for the developer, on their instructions) |
| Show you your licences, devices and downloads          | Licences, devices, account                                          | Needed to provide the service                                            |
| Send the right update, and stop a bad update spreading | Platform, versions, update results                                  | Needed to provide the service; the developer's legitimate interest       |
| Email you codes and security notices                   | Email address                                                       | Needed to provide the service; keeping your account secure               |
| Stop abuse: guessing codes, flooding, bots             | Internet address (briefly), scrambled email, sign-in attempt counts | Our legitimate interest in keeping the service safe                      |
| Show "requested from Berlin, Germany" on a sign-in     | Rough place from your internet address                              | Keeping your account secure                                              |
| Investigate problems and security incidents            | Audit logs, Cloudflare request logs                                 | Our legitimate interest; legal obligations                               |

**We never** sell your data, use it for advertising, build marketing profiles, or share it with
data brokers. We do not use it to train AI models.

---

## Who else sees it

### The app's developer

The developer of each app you use can see, in their console, **for their app only**:

- your licences for their app, and the buyer name and email they set on them;
- your devices for that app (name, platform, versions, first and last seen, a shortened piece of
  the scrambled fingerprint);
- when you signed in to their app and by which kind of method ("Steam"), but not the account
  itself;
- your account email and name **only if you agreed to share them** with that app.

Each developer sees you under a random ID that's different for every app, so developers can't
compare notes about you. Developers can't see your internet address, your other apps, your
sign-in methods or your Polaris Key account ID. They can't delete or sign out your account.

A developer can export the data their app holds about you, delete it, or move a licence from one
person to another. Moving a licence requires a reason, emails both people first, and can be undone
for 72 hours.

### Companies that help us run Polaris Key

| Company                                | What they do for us                                                                                         | What they get                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Cloudflare, Inc.**                   | Runs our servers, database, file storage and email sending. All Polaris Key data is stored with Cloudflare. | Everything described in this policy, on our behalf. Email content and recipient when we send email. |
| **Cloudflare Turnstile**               | A bot check on the email sign-in form, when it is switched on                                               | A check token and your internet address                                                             |
| **Google**                             | Sign in with Google (only if you choose it)                                                                 | The fact that you're signing in to Polaris Key                                                      |
| **Apple**                              | Sign in with Apple (only if you choose it)                                                                  | The fact that you're signing in to Polaris Key                                                      |
| **Valve (Steam)**                      | Sign in with Steam (only if you choose it)                                                                  | Your Steam ID, when we look up your public name and picture                                         |
| **Apple, Google, Valve** as app stores | Checking a store purchase, if the app sells through a store                                                 | The purchase or transaction ID, or your Steam ID                                                    |

[[OWNER: confirm this list is complete for launch, and whether Cloudflare's data processing
addendum is signed.]]

**Crash reports.** Polaris Key does not collect crash reports. If a developer connects their own
crash-reporting service (Sentry), we receive only an alert that says which release had a problem,
never the crash itself or anything about you.

### When the law requires it

We hand over data only when a valid legal order requires it, and we tell you first unless the law
forbids it. [[OWNER: confirm this commitment.]]

### If the company changes hands

If Polaris Key is sold or merged, your data goes with the service and this policy keeps applying
until you're told about a change.

---

## Where your data is stored

Polaris Key runs on Cloudflare's network. Our database and file storage are Cloudflare D1 and
Cloudflare R2. Requests are handled by the Cloudflare data centre nearest to you, which may be
outside your country. [[OWNER: state the D1/R2 location hint or jurisdiction setting, if any,
and the transfer mechanism for EU/UK data (for example the EU–US Data Privacy Framework or
Standard Contractual Clauses).]]

---

## How long we keep it

| Data                                                                                    | How long                                                                                        |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Your account: email, name, picture, sign-in methods                                     | Until you delete your account                                                                   |
| A signed-in session                                                                     | 14 days, then you sign in again. Its record is removed 30 days after it ends.                   |
| Sign-in codes and links                                                                 | 10 minutes, and they work once                                                                  |
| A pending sign-in, with the rough place it came from                                    | 10 to 15 minutes                                                                                |
| Your account activity log (sign-ins, devices removed, "approved a sign-in near Berlin") | 180 days, or until you delete your account                                                      |
| Your internet address, for limiting repeated attempts                                   | Until the limit window ends: at most one day                                                    |
| Cloudflare's request logs (see below)                                                   | [[OWNER: 3 or 7 days, depending on the Cloudflare plan]]                                        |
| Licences and scrambled keys                                                             | Until the developer deletes the licence. Deleting your account doesn't delete them (see below). |
| A device's hardware fingerprint and software details                                    | Until the device is disconnected                                                                |
| The device record itself (ID, name, platform, versions, user agent, last report)        | Until the developer deletes the licence. Disconnecting a device keeps this record.              |
| Seat on a device not seen for 90 days                                                   | The seat is freed automatically. The device record stays.                                       |
| Update counts per release                                                               | 30 days                                                                                         |
| A record of refused licence checks                                                      | 30 days                                                                                         |
| Changes developers make in the console (audit log)                                      | 180 days                                                                                        |
| Store purchase records                                                                  | As long as the licence exists                                                                   |
| Store notifications                                                                     | 30 days                                                                                         |
| Download links                                                                          | Deleted once used or expired (five minutes)                                                     |
| Package feed tokens (scrambled)                                                         | 90 days after they expire or are revoked                                                        |
| "Don't email this address" list, after a bounce or complaint                            | A scrambled address only: 90 days after a bounce; permanently after a spam complaint            |
| Your profile picture copy                                                               | Until your provider picture changes or you delete your account                                  |

**Inactive accounts.** [[OWNER: planned, not built yet. Decided: an account with no sign-in and
no licence for 36 months gets a warning email, then is deleted.]]

**Cloudflare's request logs.** Cloudflare keeps a log entry for every request to our servers,
including the web address requested and request details. We use these only to fix problems and
investigate attacks. Our own code writes no logs of its own.

---

## How to see, download or delete your data

| You want to                             | How                                                                                                                      | Status                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| See your licences and devices           | Sign in at key.plrs.im. Your library shows every licence linked to your account and the devices using each.              | Available                                              |
| Disconnect a device                     | In the portal, open the licence and choose **Remove** next to the device. Or disconnect from inside the app.             | Available                                              |
| Delete your account                     | Portal → **Account** → **Your data** → **Delete my account**                                                             | Available                                              |
| Download a copy of your data            | Portal → Account → Your data → **Download my data**                                                                      | Planned. Until then, email [[OWNER: privacy contact]]. |
| Remove one app's data from your account | —                                                                                                                        | Planned. Until then, email us or the developer.        |
| Correct your details                    | Your name and picture come from your sign-in provider: change them there and sign in again. For anything else, email us. | Available                                              |
| Get the data an app holds about you     | Ask the app's developer. They can export it from their console in one step.                                              | Available                                              |

**What deleting your account does.** It happens straight away and can't be undone. We first email
you a confirmation, then delete your account, email addresses, sign-in methods, sessions, profile
picture, account activity log, app sharing choices and package feed tokens. Your devices are
unlinked from your account.

**What deleting your account does not delete.** Your licences belong to the developer who sold
them, so they stay, with the buyer name and email the developer set on them. If you sign in the
same way again later, your licences can reappear in your library. The developer is told your
account was deleted and which of their licences were linked to it. To have a licence itself erased,
ask the developer. We also keep a record with no name or email that says an account was deleted,
and the console audit log keeps what it recorded for up to 180 days.

You also have the right to object to how we use your data, to ask us to limit it, and to complain
to your data protection authority. [[OWNER: name the lead supervisory authority, and an EU/UK
representative if one is required.]] We answer requests within one month.

---

## Cookies

We use only cookies we need to sign you in and keep you safe. **No advertising, analytics or
tracking cookies, and no third-party cookies.** That's why there's no cookie banner.

| Cookie                     | What it does                                                     | How long   |
| -------------------------- | ---------------------------------------------------------------- | ---------- |
| `__Host-pkey_portal`       | Keeps you signed in to your account                              | 14 days    |
| `__Host-pkey_signin`       | Connects the sign-in you started with the code or provider reply | 10 minutes |
| `__Host-pkey_gate`         | Holds your first sign-in while you confirm your email            | 15 minutes |
| `__Host-pkey_device_login` | Connects "sign in on another device" with the approval           | 5 minutes  |
| `__Host-pk_lcb`            | Remembers which licence you picked while signing in to an app    | 10 minutes |
| `__Host-pkey_admin`        | Keeps a developer signed in to the console                       | 8 hours    |

All of them only work on our own site, are sent only over secure connections, and can't be read
by scripts on the page.

The account cookie includes your account ID, name and email. It is signed so it can't be
changed, but it is not encrypted.

**Stored in your browser, not cookies.** The portal remembers a few preferences on your own
device: light or dark theme, list or grid view, the last five products you opened, table spacing,
and whether you've seen a one-off celebration. While you sign in, the portal holds a licence key
you typed for a moment so it isn't lost, and clears it when you return. None of this is sent to
us.

**Our websites load nothing from other companies:** no fonts, scripts or images from elsewhere.

---

## Security

- Licence keys, sign-in codes, session IDs, device tokens and package tokens are kept only as
  keyed one-way hashes.
- Hardware details are hashed on your device before they're sent.
- Every connection is encrypted.
- Sign-in attempts are rate-limited, and too many wrong codes lock that email for 15 minutes.
- You get an email when a new device signs in, a device is removed, a sign-in method changes or a
  licence key is replaced.

No system is perfectly secure. If a breach affects your data, we'll tell you and the authorities
as the law requires.

---

## Children

Polaris Key is not meant for children under [[OWNER: minimum age, for example 13, or 16 in parts
of the EU]]. We don't knowingly hold data about children under that age. If you think a child has
given us data, email us and we'll delete it. Some apps on Polaris Key may be made for younger
players. In that case the developer is responsible for getting a parent's consent.

---

## Coming later

- **Payments through Stripe.** Not live yet. When it is, the developer will be the seller
  (merchant of record) and Stripe will process your payment on the developer's own Stripe account.
  We will never see or store your card details. This section will say exactly what is shared
  before any payment is taken. [[OWNER: complete after the G1 legal review.]]
- **Cloud Sync** (saving app data like game saves to the cloud). Not live yet. It will be off
  unless the app uses it, the developer will control that data, and deleting your account will
  delete it. It won't cover shared ("floating") licences.
- **Download my data**, **remove one app from my account**, and **sign-in with passkeys**.

---

## Changes to this policy

When we change this policy we'll update the date at the top. If a change affects how we use data
you've already given us, we'll email you before it takes effect.
[[OWNER: notice period, for example 30 days.]]

## How to reach us

- Privacy questions and requests: [[OWNER: privacy email]]
- Everything else: [[OWNER: support email]]
- Post: [[OWNER: postal address]]
