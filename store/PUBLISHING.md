# Publishing Gazetteer to the Chrome Web Store

Listing copy is in `listing.md`. Screenshots are in `screenshots/`.

## Before you start: the repo is private

Three things in the listing point at GitHub, and all of them 404 for anyone
who is not signed in as you:

- the privacy policy URL the store requires
- the source link in the description
- the build badges in the README, which currently render "repo not found"

Pick one:

- **Make the repo public.** Everything above starts working with no changes.
- **Keep it private.** Host the privacy policy somewhere public instead, such
  as a GitHub Gist or a page on a site you own, and take the GitHub links out
  of `listing.md` and the badges out of the README.

## Steps

**1. Register as a developer.** https://chromewebstore.google.com/developer/dashboard

One-time 5 USD fee. Google also verifies your identity and contact email, which
can take a few days, so start this before anything else. A publisher display
name is required and appears on the listing.

**2. Build the zip.**

```sh
pnpm run package
```

Produces `gazetteer-1.0.0.zip`, roughly 57 KB. The script refuses to build if
the manifest version and package version disagree, or if the dev build stamp is
still present.

**3. Create the item.** In the dashboard, add a new item and upload the zip.
The 128px icon is read from the package, so there is nothing to upload for it.

**4. Fill in the store listing.** Copy from `listing.md`: name, short
description, detailed description, category (Productivity), and language.
Upload all three files from `screenshots/`. They are already 1280x800.

**5. Fill in privacy practices.** Also in `listing.md`: the single purpose
statement, a justification for `storage`, a justification for host access to
Google Maps, and "no" to remote code. Answer "no" to every data collection
type, then tick all three certifications. Paste the privacy policy URL.

**6. Choose distribution.** Public, or unlisted if you want to hand out the
link yourself first. Unlisted is a reasonable way to shake out problems.

**7. Submit for review.** Usually a few days. Extensions that modify Google
properties can take longer. You get an email either way, and rejections say
which policy was cited.

**8. Optional: cut a GitHub release.**

```sh
git tag v1.0.0 && git push origin v1.0.0
```

The `release` workflow builds the zip and attaches it to a GitHub release. This
is only for people installing from source. It has nothing to do with the store.

## Shipping an update later

1. Bump `version` in `package.json`. The manifest picks it up at build time.
2. `pnpm run check && pnpm run package`
3. Upload the new zip to the same item and submit again.

The store rejects a re-upload that does not increase the version number.
