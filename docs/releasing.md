# Releasing Commonlib

This document is the developer and maintainer runbook for preparing and publishing `@vrtmrz/livesync-commonlib`. Package-consumer guidance belongs in the root README.

## Release gate

Run the complete owner gate from a clean checkout:

```bash
npm ci
npm run verify:package
```

The gate type-checks Commonlib, runs its complete unit suite, verifies the source boundary, builds the distributable package, installs its exact tarball into a clean consumer, and bundles representative browser and Node entry points. The source `package.json` remains private to prevent publishing the repository root. Only the generated `.package` directory is publishable, and its manifest defaults to public publication on the `next` dist-tag.

### Lockfile reproducibility

Regenerate `package-lock.json` with the reviewed npm CLI version pinned by the `Use the reviewed npm CLI` step in `.github/workflows/publish-npm.yml`. Do this after adding, removing, or updating a dependency, even when an older local npm reports that the lockfile is already up to date. npm minor versions can differ in how they record transitive optional peer dependencies; a lockfile accepted by an older client can otherwise fail the hosted `npm ci` before any tests run.

With the currently reviewed npm version, use:

```bash
npx --yes npm@11.18.0 install --package-lock-only --ignore-scripts --no-audit --no-fund
npx --yes npm@11.18.0 ci
npm run verify:package
```

Inspect the lockfile diff before committing it. A dependency-only maintenance change must not alter the source package version, and lockfile normalisation must not be described as a package upgrade when resolved versions and integrity values are unchanged. When the workflow selects a newer reviewed npm CLI, update this example in the same change.

Before publication, run the downstream workflow against an exact Self-hosted LiveSync ref which already consumes the package. The workflow installs the tarball produced from the selected Commonlib commit, then runs LiveSync type checks, unit tests, plug-in and application builds, and CLI E2E. Real Obsidian E2E remains local-only and is required when the changed boundary affects actual plug-in composition, storage, UI, or platform behaviour.

## Preparing a release

Choose the version explicitly. Use a prerelease such as `0.1.0-rc.0` when registry installation must be validated before the first stable version. Package-proof versions are local artefacts and cannot be staged.

Prepare both stable releases and pre-releases on a reviewed pull request based on `main`. Registry staging is deliberately restricted to the exact commit which triggered the trusted workflow from `main`. If a change is not yet ready to merge, validate its local tarball and run the downstream workflow against the exact reviewed commit; do not stage it from the pull-request branch.

```bash
npm ci
npm version <version> --no-git-tag-version
npm run verify:package
npm publish --dry-run .package --tag next --access public
```

Review `package.json`, `package-lock.json`, the generated manifest, the tarball contents, the test results, and the downstream evidence. Commit only the source manifest and lockfile for the version change; `.package`, `.package-consumer`, and `artifacts` are generated and ignored. Push and open a release pull request only after the usual user checkpoint. Merge the exact reviewed release commit into `main` only after the separate merge checkpoint, then dispatch the staged-publishing workflow from that exact `main` commit.

## Historical initial npm bootstrap

The package and its Trusted Publisher are already configured. This section records the one-time bootstrap which created the package; do not use it for routine releases. Current releases use the staged-publishing workflow below.

The npm package must exist before Trusted Publishing can be configured. Bootstrap the first reviewed release candidate once from the exact reviewed commit in the draft release pull request, using an interactive npm session with 2FA:

```bash
npm ci
npm run verify:package
npm publish .package --tag next --access public
```

Confirm the authenticated npm account, `@vrtmrz` scope ownership, package name, version, tarball checksum, packed contents, source commit, and target tag immediately before publication. Treat bootstrap publication as a separate user-authorised operation. npm may assign `latest` to the first published version even when `next` is requested; leave the immutable version in place and replace `latest` only after a stable release has passed consumer validation.

Bootstrap publication was the one historical exception in which a package was published before its source pull request was merged. Do not repeat that sequence for routine releases. Current staged releases must use an exact `main` commit. If validation fails, leave the published version immutable and prepare a new pre-release version.

## Trusted staged publishing

After bootstrap, configure the npm Trusted Publisher for:

- GitHub owner and repository: `vrtmrz/livesync-commonlib`;
- workflow file: `publish-npm.yml`;
- environment: `npm`; and
- allowed action: staged publishing only.

Protect the GitHub `npm` environment with a required reviewer and permit only `main`. The trusted workflow definition and the packaged source must use the same exact `main` commit. The workflow requires its `GITHUB_REF`, workflow-triggering `GITHUB_SHA`, current remote `main`, and checked-out HEAD to match the requested full commit SHA. It then runs `verify:package`, validates the requested version, full commit SHA, and confirmation text, packs that reviewed output, records its checksum, and passes the same tarball to the protected staging job.

This equality is also a provenance boundary. npm's automatic provenance identifies the commit which triggered the trusted workflow. Checking out a different branch commit later does not change that source reference, even when the resulting tarball is otherwise correct.

Dispatch either a stable release or a pre-release from the exact reviewed commit already merged to `main`:

```bash
git fetch origin main
sha=$(git rev-parse origin/main)
gh workflow run publish-npm.yml \
  --ref main \
  -f version=<version> \
  -f expected_sha="$sha" \
  -f confirmation="stage @vrtmrz/livesync-commonlib@<version> from $sha"
```

The workflow rejects every release selected from a branch or commit other than the exact current `main` commit. This prevents an unmerged branch from changing the trusted publication job or acquiring access to the `npm` environment, and keeps the package source and provenance source aligned.

The workflow always stages to `next`. Inspect the staged package name, version, access, dist-tag, provenance, checksum, files, and source commit before approving it through npm. The packaged source and provenance source must both identify the requested `main` commit. Approval and later promotion to `latest` are separate user-authorised operations. Keep the Self-hosted LiveSync consumer pull request in draft while validating the exact registry version. If validation fails, leave that published version immutable, prepare a new pre-release on `main`, and validate the replacement. Validate a stable release in Self-hosted LiveSync before promoting it to `latest`.
