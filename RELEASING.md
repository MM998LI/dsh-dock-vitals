# Releasing dsh-dock-vitals

How this plugin gets from this directory to the plugin market. Written for the
maintainer, but it doubles as a map of what "released" means here.

## Where this plugin is distributed

Three layers, in the order the market prefers them:

| Layer | What it is | Why it exists |
| --- | --- | --- |
| npm | `dsh-dock-vitals` on registry.npmjs.org | The market installs repo-verified npm packages first, and it is the only layer that gets a download count. |
| GitHub Release | `dsh-dock-vitals-0.1.0.tgz` attached to tag `v0.1.0` | Prebuilt fallback for when npm is unreachable, mirrored slowly, or unpublished. |
| GitHub source | The repository itself | Always works; it is what the listing entry points at. |

The listing entry itself lives in [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
A copy of the file to submit is kept in `contributing/awesome-dsh-plugin.yml`.

## The one hard constraint: repository age

The listing's CI checks that the repository is **at least 1 day old**, measured
from the repository's creation time — not from the first push, and not from the
first commit. Nothing else in this process has a waiting period.

So the order is driven by one rule: **create the repository first**, then do
everything else inside that 24 hour window, then submit.

```
Day 0   1. create repository + push + add the dsh-plugin topic   <- timer starts
        2. publish to npm
        3. cut the GitHub Release with the tarball
Day 1   4. after 24h, open the listing PR
Day 1+  5. CI + maintainer review, then it shows up in the market
```

Why npm at step 2 rather than last: the listing picks the npm mapping up from
the registry automatically and nothing can be declared by hand — so a package
published later simply shows no download figure until the next collection.

Why step 2 has to follow step 1: the npm package is linked back to the
repository through its own `repository` field. Publishing before the repository
exists leaves that link dangling.

## Checklist

### 0. Before anything

```bash
cd D:\dsh\plugins\dsh-dock-vitals
node --check lib/index.js && node --check lib/gpu.js && node --check lib/client.js
npm pack --dry-run --cache D:\DSharness\_npmcache
```

- [ ] Delete the development backups in `lib/` (`*.bak-*`). They are gitignored, but they have no business in a release tree.
- [ ] `npm pack --dry-run` lists exactly nine files: `CHANGELOG.md`, `LICENSE`, `README.md`, `README.zh.md`, `cordis.patch.yml`, `lib/client.js`, `lib/gpu.js`, `lib/index.js`, `package.json`.
- [ ] `repository` / `homepage` / `bugs` in `package.json` match the final repository name.
- [ ] `node_modules/` is **not** committed. It contains a junction into this machine's profile, which would be broken for everyone else.

### 1. Create the repository

```bash
git init -b main
git config --local user.name  "MM998LI"
git config --local user.email "187600476+MM998LI@users.noreply.github.com"
git add -A
git commit -m "feat: dsh-dock-vitals 0.1.0 — composer status bar CPU/memory/GPU badge"
```

Then create `MM998LI/dsh-dock-vitals` on GitHub — an empty repository, no
README / .gitignore / license, so nothing collides with what is already here.

```bash
git remote add origin https://github.com/MM998LI/dsh-dock-vitals.git
git push -u origin main
```

- [ ] Add the **`dsh-plugin`** topic to the repository (required by the listing), plus `deepseek-harness` for discoverability.

### 2. Publish to npm

```bash
npm login
npm publish --cache D:\DSharness\_npmcache
npm view dsh-dock-vitals version
```

- [ ] The npm page links back to `MM998LI/dsh-dock-vitals`.
- [ ] `publishConfig.registry` pins the official registry, so a local mirror setting cannot redirect the publish.

### 3. Cut the GitHub Release

```bash
npm pack --cache D:\DSharness\_npmcache
```

- [ ] Create tag `v0.1.0` with title `0.1.0`, release notes copied from `CHANGELOG.md`.
- [ ] Attach the produced `dsh-dock-vitals-0.1.0.tgz` as a release asset.

### 4. Submit to the listing (after the repository is 24 hours old)

- [ ] Fork `awesome-dsh-plugin/awesome-dsh-plugin`.
- [ ] Add `data/plugins/MM998LI__dsh-dock-vitals.yml` — the contents of `contributing/awesome-dsh-plugin.yml` in this repository.
- [ ] Open a pull request that adds **that one file**. The READMEs are generated from `data/plugins/*.yml`; never edit them by hand.
- [ ] Wait for CI and maintainer review.

### 5. After it merges

- [ ] Search for `dsh-dock-vitals` in the market and check the category and description render correctly.
- [ ] Install it once and confirm it resolves through npm rather than a source download.

## Traps

- **npm writes to `D:\nodejs\cache` by default**, which the sandbox blocks — pass `--cache D:\DSharness\_npmcache` or run outside the sandbox.
- **`npm login` is interactive** and needs the account that owns the package name.
- **`npm publish` is effectively irreversible after 72 hours.** Do the step 0 checks.
- **`description.en` must end with a period.** A description containing a half-width `: ` has to be quoted in YAML.
- **Themes and skins go in `category: theme`**, not `ui`. This plugin is a UI enhancement, so it stays `ui`.
- **Never write an `npm:` key into the listing YAML** — validation rejects it.
- **Do not rename the repository after publishing.** `package.json` (three URLs), the listing YAML (`url`, `name`), and the README all point at it.
