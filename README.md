# Orchard

**The battery saving browser.**

## Get Orchard

1. Download **[OrchardSetup.exe](https://github.com/Andy09062013/updatesfororchard/raw/main/OrchardSetup.exe)** (about 7 MB).
2. Run it. If Windows says "Windows protected your PC", click **More info** then **Run anyway**.
3. It downloads the rest (about 150 MB), installs Orchard and opens it. Orchard keeps itself updated after that.

To uninstall: Windows Settings > Apps > Orchard > Uninstall.

---

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

## The installer

`OrchardSetup.exe` downloads the Chromium engine from Electron's official GitHub
release (checked against the SHA-256 in `installer.json`) and Orchard's files from
`app/` (checked against `version.json`), installs to `%LOCALAPPDATA%\Programs\Orchard`,
puts the apple icon on Orchard.exe and adds an uninstaller. Its source is in `installer/`
(build with `GOOS=windows GOARCH=amd64 go build` after making the icon resource with rsrc).
