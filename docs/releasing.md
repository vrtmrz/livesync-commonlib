# Releasing Commonlib

This document is the developer and maintainer runbook for preparing and publishing `@vrtmrz/livesync-commonlib`. Package-consumer guidance belongs in the root README.

## Commonlib-owned release checks

Run the normal owner checks from a clean checkout:

```bash
npm ci
npm run verify:package
npm run test:integration:managed
```

Together these checks type-check Commonlib, run its unit and integration suites, verify the source boundary, build the distributable package, install its exact tarball into a clean consumer, and bundle representative browser and Node entry points. These Commonlib-owned checks are the normal publication criteria. The source `package.json` remains private to prevent publishing the repository root. Only the generated `.package` directory is publishable, and its manifest defaults to public publication on the `next` dist-tag.

Downstream or real-runtime checks are appropriate when a named host-specific risk is not established by the owner tests; run those checks against the exact packed artefact and record the risk and result. LiveSync adoption and downstream validation are not general publication prerequisites. The [maintained-host examples and evidence](proven-in-use.md) page is optional context, not a release or update gate.

The package builder normalises generated directories to `0755`, ordinary files to `0644`, and declared `bin` targets to `0755` before validation. `test:package` uses a restrictive umask and verifies the packed modes, so local and hosted builds do not differ only because their caller environments use different umasks.

### Lockfile reproducibility

Regenerate `package-lock.json` with the reviewed npm CLI version pinned by the `Use the reviewed npm CLI` step in `.github/workflows/publish-npm.yml`. Do this after adding, removing, or updating a dependency, even when an older local npm reports that the lockfile is already up to date. npm minor versions can differ in how they record transitive optional peer dependencies; a lockfile accepted by an older client can otherwise fail the hosted `npm ci` before any tests run.

With the currently reviewed npm version, use:

```bash
npx --yes npm@11.18.0 install --package-lock-only --ignore-scripts --no-audit --no-fund
npx --yes npm@11.18.0 ci
npm run verify:package
```

Inspect the lockfile diff before committing it. A dependency-only maintenance change must not alter the source package version, and lockfile normalisation must not be described as a package upgrade when resolved versions and integrity values are unchanged. When the workflow selects a newer reviewed npm CLI, update this example in the same change.

When a named host-specific risk is not established by the Commonlib owner checks, run the relevant downstream workflow against an exact Self-hosted LiveSync ref which consumes the package. It installs the tarball produced from the selected Commonlib commit and runs LiveSync type checks, unit tests, plug-in and application builds, and CLI E2E. Real Obsidian E2E remains local-only and is appropriate when the named risk concerns actual plug-in composition, storage, UI, or platform behaviour. These checks are conditional on the risk; LiveSync adoption is not a general release prerequisite.

## Version compatibility policy

The Commonlib 0.2 policy begins with 0.2.0 and does not retroactively change compatibility expectations for published 0.1.x versions. Within 0.2.x, preserve published APIs, types, behaviour, supported persisted data, and exported `compat/*` paths. Intentional breaking changes belong in 0.3.0. Consumers may declare a range such as `^0.2.0`; lockfiles and `npm ci` remain the reproducible install path.

## Preparing a release

Choose the version explicitly. For the 0.2 line, start at 0.2.0. A stable candidate can use its final version on the `next` dist-tag, then be checked by exact source revision and tarball SHA-256 before the same version is promoted to `latest`. No `-next.N` or `-rc.N` version is required; use a separate prerelease version only when it is useful for a distinct candidate. Package-proof versions are local artefacts and cannot be staged.

Prepare stable releases and any optional prereleases on a reviewed pull request based on `main`. An optional prerelease may be staged from the exact reviewed pull-request branch commit. A stable release must be staged only after its exact reviewed release commit is present on `main`.

```bash
npm ci
npm version <version> --no-git-tag-version
npm run verify:package
npm publish --dry-run .package --tag next --access public
```

Review `package.json`, `package-lock.json`, the generated manifest, the tarball contents, and the Commonlib-owned test results. Add downstream evidence when a named host-specific risk requires it. Commit only the source manifest and lockfile for the version change; `.package`, `.package-consumer`, and `artifacts` are generated and ignored. Push and open a release pull request only after the usual user checkpoint. Keep a pull request in draft while a specifically planned downstream check is in progress; that check is not required when no such risk remains. Merge and publication remain separate later checkpoints.

## Historical initial npm bootstrap

The package and its Trusted Publisher are already configured. This section records the one-time bootstrap which created the package; do not use it for routine releases. Current releases use the staged-publishing workflow below.

The npm package must exist before Trusted Publishing can be configured. Bootstrap the first reviewed release candidate once from the exact reviewed commit in the draft release pull request, using an interactive npm session with 2FA:

```bash
npm ci
npm run verify:package
npm publish .package --tag next --access public
```

Confirm the authenticated npm account, `@vrtmrz` scope ownership, package name, version, tarball checksum, packed contents, source commit, and target tag immediately before publication. Treat bootstrap publication as a separate user-authorised operation. npm may assign `latest` to the first published version even when `next` is requested; leave the immutable version in place and replace `latest` only after a stable release has passed the Commonlib owner checks and any applicable targeted host checks.

Bootstrap publication was the one historical exception which used direct `npm publish`. Do not repeat that operation for routine releases. Optional prereleases use protected staged publishing and may select an exact reviewed branch commit; stable releases use an exact `main` commit. If the owner checks or an applicable targeted host check fails, leave the published version immutable and prepare a new version.

## Trusted staged publishing

After bootstrap, configure the npm Trusted Publisher for:

- GitHub owner and repository: `vrtmrz/livesync-commonlib`;
- workflow file: `publish-npm.yml`;
- environment: `npm`; and
- allowed action: staged publishing only.

Protect the GitHub `npm` environment with a required reviewer and permit only `main`. The trusted workflow definition always runs from `main`. A pre-release may package an exact commit from a reviewed draft branch, while a stable release also requires the package source and workflow-triggering commit to be the exact current `main` commit. The workflow confirms that the selected source branch still points to the requested full commit SHA, checks out that SHA, runs `verify:package`, validates the requested version and confirmation text, packs the reviewed output, records its checksum, and passes the same tarball to the protected staging job.

npm's automatic provenance identifies the `main` commit which triggered the trusted workflow. For an optional prerelease selected from a draft branch, this identifies the trusted workflow source rather than the packaged source commit. Record and verify the separate `source_ref`, exact package SHA, and tarball checksum before approving the staged version. This provenance distinction is accepted for an immutable prerelease when a consumer check is planned before merge. A stable release requires the workflow and package source to be the same exact `main` commit.

When using an optional pre-release, dispatch it from its exact reviewed draft branch commit:

```bash
source_ref=separate-setting-lifecycle
git fetch origin "$source_ref"
sha=$(git rev-parse "origin/$source_ref")
gh workflow run publish-npm.yml \
  --ref main \
  -f version=<version> \
  -f source_ref="$source_ref" \
  -f expected_sha="$sha" \
  -f confirmation="stage @vrtmrz/livesync-commonlib@<version> from $sha"
```

For a stable release, use `source_ref=main`. The workflow rejects a stable release selected from another branch, rejects a stable release without its trusted workflow commit, and requires the workflow-triggering SHA to equal the packaged `main` SHA. The workflow dispatch itself uses `--ref main` for every release, so an unmerged branch cannot change the trusted publication job or acquire access to the `npm` environment.

The workflow always stages to `next`. Inspect the staged package name, version, access, dist-tag, provenance, checksum, files, selected source branch, and source commit before approving publication to npm. After approval publishes the version, fetch that exact registry version and compare its SHA-256, package name and version, and provenance with the reviewed staged artefact and source revision; confirm that `next` points to that version. Install the fetched registry artefact in a clean consumer and run the relevant package checks before requesting promotion. Stage approval and later promotion to `latest` are separate user-authorised operations. Promote the same version only after those registry checks pass and any applicable targeted host checks are complete. If a check fails, leave the published version immutable and prepare a new version. Keep consumer pull requests in draft only while a specifically planned host check is in progress; consumer adoption is not a precondition for Commonlib merge or release.

## Publishing a GitHub Release

Create a GitHub Release for each stable Commonlib release after the exact registry artefact has passed the Commonlib owner checks and the version has been promoted to `latest`. Complete any applicable targeted host checks before release. Target the exact `main` commit used to build the published package.

Protect the GitHub `github-release` environment with a required reviewer and permit only `main`. The manually dispatched workflow first verifies the release with read-only repository access. Only its protected publication job receives `contents: write` access.

Set the exact version and release commit, then dispatch the workflow from `main`:

```bash
version='<version>'
release_sha='<full-release-commit>'
gh workflow run publish-github-release.yml \
  --ref main \
  -f version="$version" \
  -f expected_sha="$release_sha" \
  -f confirmation="release @vrtmrz/livesync-commonlib@$version from $release_sha"
```

The workflow requires the release commit to be an ancestor of its trusted `main` commit, reads the exact source version and corresponding release notes from that commit, confirms that npm `latest` points to the version, and rejects an existing version tag. Review those results before approving the `github-release` environment. The protected job rechecks npm `latest`, then creates the version tag and GitHub Release and verifies that the tag points to the selected commit.

Treat dispatching and approving the GitHub Release workflow as separate user-authorised remote operations. Verify the version, exact release commit, and release notes immediately before approval.
