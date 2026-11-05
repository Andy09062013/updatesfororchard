# Orchard updates

This repo is where Orchard Browser gets its updates from. Every copy of Orchard
checks `version.json` here when it opens (and every 4 hours). If the version is
newer than what it's running, it downloads the files in `app/`, checks each one
against its SHA-256 in `version.json`, and shows a green **Update** button.

## Sending an update

1. Replace the files in `app/` with the new ones.
2. Bump `"version"` in `app/package.json` (like `1.8.0` → `1.8.1`).
3. Run `python make_release.py "what's new"` to rebuild `version.json`.
4. Commit and push (or upload the changed files on github.com).

## Keep this account safe

Whatever is in `app/` runs on everyone's computer who has Orchard, so turn on
two-factor login for this GitHub account and never give anyone write access
you don't trust.

Updates only replace Orchard's own code. A new Chromium engine still needs a
fresh download of the full Orchard zip; raise `minElectron` in `version.json`
when an update needs that, and older copies will say so instead of updating.
