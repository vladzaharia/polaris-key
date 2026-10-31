# Tidewater Studio: the React kit sample (Vite)

Tidewater Studio by Harbor Audio, gated by `@polaris-key/react`. It shows:

- **the drop-in**: `<PolarisKeyProvider config={polarisKey}>` and the kit's
  `<PolarisKeyGate>` in `src/main.tsx`; the gate draws every screen the license calls for, then the
  app;
- **the product as the hero**: Tidewater's name and accent come from the SDK's presentation, with
  no theme code;
- **the parts**: `<UpdatePrompt>`, `<Devices>`, `<Settings>` and `<About>` from
  `@polaris-key/react/kit` on the Settings page; inside the provider they read the SDK themselves
  (rename and remove a device, change a setting, update, copy diagnostics).

The framework page is [React](https://key.plrs.im/docs/build/ui/frameworks/react/).

## Run it against the fixtures

The default runs on the Tidewater fixture in `src/fixtures.ts`: no Worker, no network, no keys.

```sh
# .npmrc: @polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
npm install
npm run dev
```

- `pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA` activates, with no account.
- Any other `pkey_tidewater_` key hits the device limit once, then activates.
- Sign in shows a code, then signs in about four seconds later.
- `?state=ok`, `grace`, `expired` or `revoked` pins the gate for one load (an account holds it).
- `?identity=off` turns Identity off; `?attach=other`, `owned` or `failed` ends Add your name and
  email on that step.

## Activation without an account

A key holds the license with no account. On the fixtures the whole path runs with no network:
enter the key, Add your name and email, type a name and email, Continue, Added, then Start using.
The fixture's sign-in answers as the person you typed. **Manage license** in the app bar stands in
for the desktop host's menu item: it opens the kit's Settings, whose account row says "Not in an
account" with Add your name and email, and "Signed in as ..." once it is added.

| Step                    | Role and name                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Gate                    | button "Use a license key"                                                                                  |
| Key                     | textbox "License key"; button "Activate license"                                                            |
| Done                    | heading "Tidewater Studio is ready"; buttons "Add your name and email", "Start using Tidewater Studio"      |
| Add your name and email | textboxes "Name" and "Email"; buttons "Continue", "Cancel"                                                  |
| Added                   | heading "Tidewater Studio is in your account"; button "Start using Tidewater Studio" ("Done" from Settings) |
| Settings row            | heading "Account and license"; text "Not in an account"; button "Add your name and email"                   |

Other ends: `?attach=other` ("You signed in with a different account"), `?attach=owned` ("This
license is in a Polaris Locker account") and `?attach=failed` ("Try again"). With `?identity=off`
the action is "Add it in Polaris Locker".

## Run it against a Worker

Replace `src/polaris.config.ts` with the file `pkey sdk --lang react --write` generates, then:

```sh
npm run live
```

## Inside this repository

```sh
mise exec node@22 -- pnpm --filter @polaris-key/react build
cd examples/ui/react-vite
mise exec node@22 -- ../../../packages/admin/node_modules/.bin/vite --config vite.repo.config.ts
mise exec node@22 -- ../../../node_modules/.bin/tsc --noEmit -p tsconfig.repo.json
```

`vite.repo.config.ts` points `@polaris-key/react` at the repo's build and its React.
