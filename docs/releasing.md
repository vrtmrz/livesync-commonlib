# Releasing Commonlib

This document is the developer and maintainer runbook for preparing and publishing `@vrtmrz/livesync-commonlib`. Package-consumer guidance belongs in the root README.

## Release gate

Run the complete owner gate from a clean checkout:

```bash
npm ci
npm run verify:package
```

The gate type-checks Commonlib, runs its complete unit suite, verifies the source boundary, builds the distributable package, installs its exact tarball into a clean consumer, and bundles representative browser and Node entry points. The source `package.json` remains private to prevent publishing the repository root. Only the generated `.package` directory is publishable, and its manifest defaults to public publication on the `next` dist-tag.

Before publication, run the downstream workflow against an exact Self-hosted LiveSync ref which already consumes the package. The workflow installs the tarball produced from the selected Commonlib commit, then runs LiveSync type checks, unit tests, plug-in and application builds, and CLI E2E. Real Obsidian E2E remains local-only and is required when the changed boundary affects actual plug-in composition, storage, UI, or platform behaviour.

## Preparing a release

Choose the version explicitly. Use a prerelease such as `0.1.0-rc.0` when registry installation must be validated before the first stable version. Package-proof versions are local artefacts and cannot be staged.

From a release branch based on `main`:

```bash
npm ci
npm version <version> --no-git-tag-version
npm run verify:package
npm publish --dry-run .package --tag next --access public
```

Review `package.json`, `package-lock.json`, the generated manifest, the tarball contents, the test results, and the downstream evidence. Commit only the source manifest and lockfile for the version change; `.package`, `.package-consumer`, and `artifacts` are generated and ignored. Push and open a release pull request only after the usual user checkpoint.

## Initial npm bootstrap

The npm package must exist before Trusted Publishing can be configured. Bootstrap the first reviewed release candidate once from the exact reviewed commit in the draft release pull request, using an interactive npm session with 2FA:

```bash
npm ci
npm run verify:package
npm publish .package --tag next --access public
```

Confirm the authenticated npm account, `@vrtmrz` scope ownership, package name, version, tarball checksum, packed contents, source commit, and target tag immediately before publication. Treat bootstrap publication as a separate user-authorised operation. npm may assign `latest` to the first published version even when `next` is requested; leave the immutable version in place and replace `latest` only after a stable release has passed consumer validation.

Keep the release pull request in draft while the published artefact is validated in Self-hosted LiveSync. If validation succeeds, merge the exact reviewed commit. If validation fails, leave the published version immutable and prepare a new pre-release version.

## Trusted staged publishing

After bootstrap, configure the npm Trusted Publisher for:

- GitHub owner and repository: `vrtmrz/livesync-commonlib`;
- workflow file: `publish-npm.yml`;
- environment: `npm`; and
- allowed action: staged publishing only.

Protect the GitHub `npm` environment with a required reviewer and permit only the `main` branch. The workflow accepts only the exact commit currently on `main`, runs `verify:package`, validates the requested version and confirmation text, packs that reviewed output, records its checksum, and passes the same tarball to the protected staging job.

Dispatch it with the exact stable or prerelease version and full commit SHA:

```bash
sha=$(git rev-parse origin/main)
gh workflow run publish-npm.yml \
  --ref main \
  -f version=<version> \
  -f expected_sha="$sha" \
  -f confirmation="stage @vrtmrz/livesync-commonlib@<version> from $sha"
```

The workflow always stages to `next`. Inspect the staged package name, version, access, dist-tag, provenance, checksum, files, and source commit before approving it through npm. Approval and later promotion to `latest` are separate user-authorised operations. Validate the exact registry version in Self-hosted LiveSync before promoting a stable release.
