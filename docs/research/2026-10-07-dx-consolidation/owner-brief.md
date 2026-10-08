# Owner brief: developer and administrator experience consolidation (2026-10-07)

_The owner's request, verbatim. It is direction, not gospel: every item may be changed, pushed back
on, split, merged or dropped where that gives a better, simpler system._

Now that we have done a few extensive feature passes, we need to do a bunch of cleanup and consolidation of the developer experience. The user experience is great, but the admin/developer side needs some extra work.

Let's have a bunch of subagents go through everything we provide and come up with a consolidation plan. Everything I list below should not be taken as gospel but as just my thoughts on the direction we should take. Anything in here can be changed by you or the subagents for best experience.

# General Concepts

Below, you will find instructions for specific services and features we provide. In addition to these specific instructions, we should have some basic concepts and instructions that should be kept in mind across the project.

- Similar features and services should be consolidated
- Developers/Administrators should have flexibility in configuration, to an extent
- Too many configuration choices and matrices cause friction; reduce the configuration surface area when possible
- Ensure we provide excellent onboarding to our developers and administrators when something isn't configured
  - Step by step wizards and instructions
  - Example code
  - Automatic configuration where possible
- If something can be automated without the user's intervention, do it. If we have credentials available at the platform or product level that allow us to enable a storefront for the user, it should just be done instead of the user having to go through multiple steps.
- Shared technology/concepts should be gracefully degraded based on service availability. Examples include:
  - Subscription licenses should be available even if Commerce is not active
  - Distribution/Commerce pages for, for instance, App Store, will contain as much data as it can get from whichever sources are enabled

# Products

Products should be easy to add and administer. Each product has a core set of features, along with additional optionally-enabled features. The current set is a good starting point, but can be made better.

We should have a step-by-step wizard which allows us to easily add a product. After creating the product, we should have an "Integration" section which gives instructions on how to integrate the various components and services into their app. This should include code samples, instructions per-service, etc. We want the documentation to be in-app and easy to see and understand.

Add a banner or button or something to dismiss the entire section. This should be exposed after a handshake and data exchange happens end to end. At that point, we can consider integration done and allow the user to hide the whole section. However, this should be a user choice as they might release multiple platforms, etc.

# Licenses

Licenses should be cleaned up and simplified. Right now there's a lot of abstraction layers and comingling.

When licenses are created through the admin portal, they should either be bound to an account or free-floating. Licenses that are bound need to sign in to the account to use the license. Free-floating licenses can be used as-is or associated with an account. While associating with an account is ideal, floating licenses can remain floating.

## Account Association

When creating a license associated with an account (because the user signed in with their account, OIDC or local), if the account exists it will automatically receive the license and show it in the portal.

Associating with an account gives you centralized view into your apps, along with cloud saves (and anything else you know of that is account-bound).

### Automatic Minting

If the user tries using an application they do not have access to, one of several things can happen based on the configuration:

- Mint a new license for everyone
- Mint a new license based on OIDC groups
- Do not mint a new license, reject the sign in.

We should be able to configure the license everyone gets, as well as per-group mappings, if applicable.

If a license is automatically minted at login time, the device attachment should be automatic. A license key should not be generated but can be done manually after the fact by an admin.

The first two, if applicable to the user, will also allow them to see the application in the "Discover" tab and self-mint a token. This would be identical to if it were minted at application use time.

## Entitlements

Licenses will have entitlements, which previously might have been co-mingled with Config. We want entitlements to be explicitly associated with a particular license and user.

Licenses can have sub-licenses, which represent things like IAPs, DLCs, feature packs, etc. These will have their own entitlements which propagate up to the license itself.

Because entitlements can include IAPs (which could be bought multiple times), we should have a way to include multiple of the same entitlement, as well as redemption status within the app/game (especially for IAPs around in-game currency).

These entitlements really could be anything, but should also include platform-level things like update channels (if available), feature enablement (like cloud sync), etc.

## Tiers, Config Profiles, etc

Let's HEAVILY clean up tiers. License tiers should be associated with a config profile (if available, which they cannot override), have entitlements set, as well as licensing details (expiry, # devices, etc etc)

The config flow then becomes:

    user (if set) > license > config profile > defaults

The licensing metadata stays:

    license > tier > defaults

That allows us to still override things for each license, but realistically we will associate a tier with a config profile and not override anything at the tier level.

## Subscriptions

We should be able to support subscriptions, both within Polaris Key and in third party stores, where available. This allows us to manage and renew licenses automatically. A license can therefore be:

- Lifetime
- With a defined expiry
- For a specific version
- Renewable, with a moving expiry date
- Renewable, with a moving expiry date and perpetual downloads
- Whetever else you think of

As always, this should be configurable by the product's owners, depending on what model they want to provide. Jetbrains' perpetual model, where you receive the latest version as long as your subscription is active, which then "degrades" gracefully into a perpetual license that allows access to the last version that was available while active.

This can also work, for instance, for a one year license with upgrades for the year, and the last released version available forever.

We might also choose to provide a license for all 1.x updates forever, then a subscription for 2.x, then expiry with perpetual for 3.x. Our licensing and subscription system should be able to account for all of these.

# Managed Config

Configuration is mostly good as is, just with a few changes needed. Apart from splitting out entitlements, this is mostly a verification layer.

We should be able to have three config types:

- Regular config
- Secret (write-only management, read-only runtime)
- Edge-minted (no management, read-only runtime)

Each config type can be set to one of several visibility levels:

- Visible in app, changeable
- Visible in app, read-only
- Invisible in app

This allows us to have secrets delivered securely to users such as API keys. All config entries should be syncable using the Cloud Sync feature to ensure settings are consistent across instances.

## Cloud Sync

Cloud Sync allows us to synchronize various parts of the app to ensure we can restore the session at any time from any instance.

This means:

- All config entries, managed and unmanaged
- Any assets, session state, etc needed to rehydrate a session
- Conflict handling when local and remote disagree
- Anything else you might think should be important to sync

A lot of synchronization will be developer-driven, so ensure our SDKs allow easy access to cloud sync information and assets, ideally using existing conventions like managed configs to deliver the information and not duplicate logic.

# Release

An application can deliver multiple types of content, such as:

- Application (dmg, exe, msi, zip, etc)
- Content and content packs
- Packages (npm, pypi, etc)
- Hashes (SHA256, MD5) for file verification

Content might be compiled against/restricted to a specific OS (ie. macOS), to a specific platform (ie. arm64), etc. We should ensure the UI, both on the console and customer side reflects this. Don't provide macOS-specific distribution channels and storefronts if we're not producing a macOS build.

## Distribution Channels

Applications can be distributed on one of several distribution channels, including but not limited to:

- Polaris Key (direct download)
- Steam (macOS, Windows, etc)
- Apple App Store (macOS, iOS, etc)
- Apple TestFlight (macOS, iOS, etc)
- Google Play Store (Android)
- itch.io
- NuGet/WinGet (Windows)
- Homebrew (macOS, Linux)
- Package feeds (ie. npm, pypi, etc)
  - Polaris Key has built-in package feeds
  - We should also have the ability to push to a centralized feed if desired
- etc etc etc

Distribution channels can be, but are not always, associated with a Commerce Storefront (ie. Apple App Store), but the two concepts should be separated. Releases and distribution channels deals with the actual artifacts being released and distributed to the right storefronts, while Commerce deals with the storefronts themselves (prices, regional availability, etc).

If a distribution channel is not set up, we should provide easy to use step by step instructions on how to do it. If it is set up, show information on the status of the setup and what is published. If a distribution channel also sets up its storefront, it should automatically activate as well (ie. don't make the user do this twice, once for releasing and once for selling; try and at least consolidate any shared settings ahead of time).

Not all applications will be available in all release channels. For instance, you can't get WIndows apps on the Apple App Store. We should gate distribution channels and storefronts based on the type of application we're developing.

Distribution should be automated whenever possible. If the user wants to enable Homebrew and we have all the requirements for it already available, then enable it on the spot (after confirmation). Similarly, new releases should be sent to distribution channels automatically.

When not automateable, the user should be provided step by step instructions to enable the distribution channel.

Customers should see... whatever is needed for the distribution channel -- if it's Polaris Key, it's the downloads themselves. If it's App Store, a link to the app. If it's a developer-ish solution (like brew, winget, a package feed, etc) then provide step by step instructions. A package might have multiple distribution channels, in which case the user should see all applicable ones (ie. a macOS app that also ships a CLI might be Self-Hosted/Polaris Key, in the Mac App Store, and in Homebrew) for the product they're looking at.

Each distribution channel should have a sidebar menu entry (maybe under a sub-section) to allow us to quickly switch between them. We should only see relevant and available distribution channels for the releases we have. If a channel includes a storefront, we should combine actions whenever possible (ie. if the channel comes for free when creating a commerce storefront, we should do it) and use a central page to show information from both sides. If one side isn't enabled, we should just not show its information in the other, and provide the wizard (ie. if we activated App Store channel but not commerce, we should only show channel information in the channel page and wizard in the storefront page. If both were activated, then we should show the same page with both information when clicking either one).

## Feeds

We have self-distributed feeds (ie. npm, pypi, etc). If an application publishes to a feed, the developer should be able to manage the application and its versions.

We should also have the ability to push to the centralized feeds (ie. npmjs.com, etc) in addition to our internal feeds.

Polaris Key feeds should become protected behind a licensed token of some sort. Think of how Web Awesome/Font Awesome/JFrog distribute their packages via custom login. Right now, I believe they're all public, so there's no authentication support, but we should be able to mint keys on the user's account which gives access to all the feeds and the packages **they** have available on each feed. Customers shouldn't see our internal SDKs in the npm/pypi/etc feeds, for instance, but developers' tokens should show them as they would be available for that account.

Instructions for signing in to the feed and downloading the release should be provided.

We should periodically clean up our feeds. For instance, Polaris Key will push vX.Y.Z-main.A which are in-progress builds. These should be cleaned up with the next full version so that we don't have them populating the feeds.

## Managed Updates

We should use whatever tools are possible to build-in automatic updating. On macOS, this generally is Sparkle, if we're using a distribution channel that automatically pushes updates, then we should ensure everything is set up to push those updates, etc.

We should have multiple update feeds/channels. Applications can define their own, but we should always have `stable`, `beta` and `dev` pre-configured. `beta` and `dev` would need to be added to a license tier to be enabled, but the default should always have `stable` available. A particular release might only be pushed up to particular feeds, and can be promoted/demoted.

## Non-Application Artifacts

Applications are able to distribute non-application artifacts via Polaris Key. This includes, for instance, content packs for games that are downloaded or streamed in.

If there is a tool or technology that we can use to make this seamless, we should do so. Examples include Background Assets, etc.

## Distribution Channel Parity

All distribution channels should try and be configured as much as possible to ensure parity in features and configuration and have a single source of truth that updates all storefronts at once. Ideally, this would include deprecating/pushing releases, rollouts, etc etc. We should start from a common base and add per-channel information to supplant a core set of data and actions.

# Commerce

Commerce specifically deals with storefronts, that is, the aspect of managing payments, transactions, license/entitlement grants, etc etc

Similar rules apply as to the Distribution Channels:

- Simple step-by-step instructions for unconfigured storefronts.
- Easy to use, well-laid out information for configured storefronts.
- Easy to use, well-laid out settings, both global and per-storefront to manage the connectors and data
- Parity across storefronts as much as possible

Commerce storefront setup will vary wildly for each service, but we should try and standardize as much of it as we can, while also exposing storefront-specific setup and configuration. For instance, the Polaris Key storefront likely will need Stripe or other payment provider credentials (optionally, if we want to charge), App Store might have specific fields it requires, etc.

If a customer purchases something in a third-party storefront and links their account to us, we should automatically provision or assign licenses to their Polaris Key account. This includes product licenses, entitlement/sub-licenses, etc. This should be kept in sync with the storefront itself, so if a customer refunds something, we also remove their license.

Subscriptions will generally come from storefronts, but the licensing system behind those subscriptions should be available even if Commerce is disabled.

# Identity

We want to make sure our identity system is solid:

- We should support multiple SSO providers, with an email domain(s -- yes, multiple) linking to specific OIDC providers
- Applications can also set their own custom SSO provider to use (ie. if they have their own account system)
- Users can sign in using one of the above OIDC providers, magic email link, or via another device (or any other authentication methods, passkeys etc)
- User accounts are tied to their email addresses, which allow us to auto-link any licenses associated with that email
- On OIDC sign in, we pull any profile information we can and pre-fill it, but require the user to fill the rest
- Magic Email sign in is always available
- Users can associate more accounts/passkeys/etc through the customer portal to allow them to sign in in multiple ways
- Some storefronts have their own account systems; their system should ALWAYS be available if the product is distributed through it
- Otherwise, applications are free to set what sign in methods should be available to their users
- On sign-in, users are able to link an existing license or have it minted for them (see above)
- Users should be able to replace devices if there's no slots available
- Users should be able to consent to data being shared with the app (profile information, cloud sync, etc) with the ability to only provide some data.
- User accounts are NOT required -- a free floating license that the user doesn't want to tie to their account is completely valid, it just doesn't get any account-based services

Users should be able to sign in across experiences:

- Customer portal
- Web apps and sites
- Games, on phones, desktops, etc
- Phone / tablet / TV apps
- CLI apps
- TUIs
- etc

On OIDC sign in, if an account doesn't exist, we should pull information from OIDC to try and fill out a profile.

- All fields including photo should be overwritable for the user
- Provide suggestions from OIDC accounts linked, but allow the user to choose their own values
- Screen Name should be a concept we have, and should be pulled from the various providers with the user able to switch between them or set their own.
- Birth Date should also be a concept we have, to allow us to in the future restrict access to mature content. This should also be pulled from OIDC profile if available
- The user should confirm and accept terms/privacy notice before continuing

Console/Management accounts go through the same accounts system, allowing a user to have access to both the management portal and their own bound licenses. We should associate permissions with the account and restrict access as needed. For instance, customers who are not developers should not be able to access the management portal.

The goal here is to provide an extensible sign in system that partners can use to allow users to sign in to their apps with one of many systems, including their own, our own, and customers' SSO accounts. All of them should be abstracted away, essentially making us a semi-federated OIDC IdP.

## Access Tokens

Access tokens should be createable per-user (admin or customer) and provide them with access to their feeds and available packages. Developers and administrators should have access to SDK packages in addition to whatever packages their customer accounts have access to.

# Administration

The Console needs its Platform settings expanded to include the things that are configurable. It should be laid out intelligently, with commonly changed settings above others. We should switch between the "Platform" sidebar and the "Product" sidebar depending on the context we're in.

## RBAC

The Console should get proper RBAC support. This means:

- User access to the console itself
- Access to individual apps
- Access to platform settings

Ideally, we should be able to restrict features per-product or platform-wide as part of this, as well. OIDC support should be included, including mappings to set various states (ie. a group gives access to the console, another group gives access to an app's storefront settings, a OIDC claim gives access to the entire project, etc).

Administrators should also be subject to RBAC.

- We should have a "Superadmin" role which provides access to everything, current and new.
- We should have an "Platform Admin" role which provides access to the console and Platform settings, and
- We should have "{Product} Admin" roles for each product we have
- "Console Access" should be a role that gives _only_ console access and is intended to be used with other roles.
  - A user that has only console access should see a page asking them to contact an administrator for permission (same as if you manually went to a page you aren't supposed to).
- A user may have multiple roles, and should get the sum of all of their access.

Basically, create a solid RBAC system that rivals big platforms like Github, etc.

# Minor Changes / Fixes

## Customer Portal

- What's New should be formatted, and potentially summarized (with full notes available on expansion)
- The number of devices in the product sidebar should be a pill
- Product sidebar doesn't quite match layout as you scroll down; maybe a slight reorganization here? Some consolidation, some cleanup. But generally looks great
- If the license was granted via OIDC, the "License source" should be "Automatic Grant"
- The license type "Standard", etc pill should be in the top-right of the License Details card
- "0 out of 5 devices" in the License Details card should be removed; it's already well encapsulated in the next card down

## Administration Console

- Let's revert back to a more simplified product card. I like the name/slug header section. The main section should be a row with the icons for enabled services. No additional details.
- On mobile, we should simply have the product name and a colored pip/dot for each enabled service

---

In general, there's a lot of layers and abstractions that might not really be needed anymore. We can clean up a lot of the confusing elements and interdependencies and allow the developer and administrators an easy to set up and maintain system.

In addition to the experience audits, we should also run code quality audits to ensure we don't have duplicated code, code smells, and that we have consistency, style, extensibility and modularness, etc.

This is a MASSIVE undertaking covering essentially the entirety of the product, so you should use as many subagents and workflows as possible. As I said above, all of these are my top of mind ramblings, and should be taken with a grain of salt. Push back on things you think should be pushed back on, edit whatever you want, add and remove items, split and combine things. Do whatever you need to to get a fully feature-rich and functional, easy to use system.

We have a lot of inflight work which can be affected by this, so ensure you go through the entirety of the todo work and consolidate, edit, clean up, and ultimately add anything that is missing or needed.
