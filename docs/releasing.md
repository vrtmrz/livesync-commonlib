# Releasing Commonlib

This document is the developer and maintainer runbook for preparing and publishing `@vrtmrz/livesync-commonlib`. Package-consumer guidance belongs in the root README.

## Release gate

Run the complete owner gate from a clean checkout:

```bash
npm ci
npm run verify:package
```

The gate type-checks Commonlib, runs its complete unit suite, verifies the source boundary, builds the distributable package, installs its exact tarball into a clean consumer, and bundles representative browser and Node entry points. The source `package.json` remains private to prevent publishing the repository root. Only the generated `.package` directory is publishable, and its manifest defaults to public publication on the `next` dist-tag.

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

Before publication, run the downstream workflow against an exact Self-hosted LiveSync ref which already consumes the package. The workflow installs the tarball produced from the selected Commonlib commit, then runs LiveSync type checks, unit tests, plug-in and application builds, and CLI E2E. Real Obsidian E2E remains local-only and is required when the changed boundary affects actual plug-in composition, storage, UI, or platform behaviour.

## Preparing a release

Choose the version explicitly. Use a prerelease such as `0.1.0-rc.0` when registry installation must be validated before the first stable version. Package-proof versions are local artefacts and cannot be staged.

Prepare both stable releases and pre-releases on a reviewed pull request based on `main`. A pre-release may be staged from the exact reviewed pull-request branch commit so that the registry artefact can be validated in Self-hosted LiveSync before the Commonlib change is merged. A stable release must be staged only after its exact reviewed release commit is present on `main`.

```bash
npm ci
npm version <version> --no-git-tag-version
npm run verify:package
npm publish --dry-run .package --tag next --access public
```

Review `package.json`, `package-lock.json`, the generated manifest, the tarball contents, the test results, and the downstream evidence. Commit only the source manifest and lockfile for the version change; `.package`, `.package-consumer`, and `artifacts` are generated and ignored. Push and open a release pull request only after the usual user checkpoint. Keep a pre-release pull request in draft while its exact registry artefact is validated in Self-hosted LiveSync. Merge and stable publication remain separate later checkpoints.

## Historical initial npm bootstrap

The package and its Trusted Publisher are already configured. This section records the one-time bootstrap which created the package; do not use it for routine releases. Current releases use the staged-publishing workflow below.

The npm package must exist before Trusted Publishing can be configured. Bootstrap the first reviewed release candidate once from the exact reviewed commit in the draft release pull request, using an interactive npm session with 2FA:

```bash
npm ci
npm run verify:package
npm publish .package --tag next --access public
```

Confirm the authenticated npm account, `@vrtmrz` scope ownership, package name, version, tarball checksum, packed contents, source commit, and target tag immediately before publication. Treat bootstrap publication as a separate user-authorised operation. npm may assign `latest` to the first published version even when `next` is requested; leave the immutable version in place and replace `latest` only after a stable release has passed consumer validation.

Bootstrap publication was the one historical exception which used direct `npm publish`. Do not repeat that operation for routine releases. Current pre-releases use protected staged publishing and may select an exact reviewed branch commit; stable releases use an exact `main` commit. If validation fails, leave the published version immutable and prepare a new pre-release version.

## Trusted staged publishing

After bootstrap, configure the npm Trusted Publisher for:

- GitHub owner and repository: `vrtmrz/livesync-commonlib`;
- workflow file: `publish-npm.yml`;
- environment: `npm`; and
- allowed action: staged publishing only.

Protect the GitHub `npm` environment with a required reviewer and permit only `main`. The trusted workflow definition always runs from `main`. A pre-release may package an exact commit from a reviewed draft branch, while a stable release also requires the package source and workflow-triggering commit to be the exact current `main` commit. The workflow confirms that the selected source branch still points to the requested full commit SHA, checks out that SHA, runs `verify:package`, validates the requested version and confirmation text, packs the reviewed output, records its checksum, and passes the same tarball to the protected staging job.

npm's automatic provenance identifies the `main` commit which triggered the trusted workflow. For a pre-release selected from a draft branch, this identifies the trusted workflow source rather than the packaged source commit. Record and verify the separate `source_ref`, exact package SHA, and tarball checksum before approving the staged version. This provenance distinction is accepted for an immutable pre-release used to validate the consumer before merge. A stable release requires the workflow and package source to be the same exact `main` commit.

Dispatch a pre-release from its exact reviewed draft branch commit:

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

The workflow always stages to `next`. Inspect the staged package name, version, access, dist-tag, provenance, checksum, files, selected source branch, and source commit before approving it through npm. Approval and later promotion to `latest` are separate user-authorised operations. Keep the Commonlib and Self-hosted LiveSync consumer pull requests in draft while validating the exact registry pre-release. If validation fails, leave that published version immutable and prepare a new pre-release. After successful consumer validation, merge Commonlib only through its separate maintainer gate. Validate a stable release in Self-hosted LiveSync before promoting it to `latest`.
