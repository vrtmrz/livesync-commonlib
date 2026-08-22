import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractReleaseNotes, prepareGitHubRelease } from "./prepare-github-release.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";

function validRelease(overrides = {}) {
    const version = overrides.version ?? "0.1.18";
    return {
        sourceManifest: {
            name: "@vrtmrz/livesync-commonlib",
            version,
            private: true,
            ...overrides.sourceManifest,
        },
        updates:
            overrides.updates ??
            "# Updates\n\n## Unreleased\n\n## 0.1.18\n\n### Added\n\n- One.\n\n## 0.1.17\n\n- Older.\n",
        version,
        expectedSha: overrides.expectedSha ?? sha,
        confirmation: overrides.confirmation ?? `release @vrtmrz/livesync-commonlib@${version} from ${sha}`,
    };
}

describe("GitHub Release preparation", () => {
    it("extracts only the selected release body", () => {
        assert.equal(prepareGitHubRelease(validRelease()), "### Added\n\n- One.");
    });

    it("accepts CRLF update files", () => {
        const release = validRelease();
        assert.equal(
            extractReleaseNotes(release.updates.replaceAll("\n", "\r\n"), release.version),
            "### Added\n\n- One."
        );
    });

    for (const [name, overrides, message] of [
        ["prerelease version", { version: "0.1.19-rc.0" }, /Invalid stable release version/u],
        ["short commit", { expectedSha: "0123456" }, /full lowercase SHA/u],
        ["different package", { sourceManifest: { name: "other" } }, /Unexpected package name/u],
        ["source version mismatch", { sourceManifest: { version: "0.1.17" } }, /Source manifest version/u],
        ["public source root", { sourceManifest: { private: false } }, /source repository manifest/u],
        ["incorrect confirmation", { confirmation: "release something else" }, /Confirmation must be/u],
        ["missing notes", { updates: "# Updates\n\n## Unreleased\n" }, /exactly one/u],
        ["duplicate notes", { updates: "## 0.1.18\n\nOne\n\n## 0.1.18\n\nTwo\n" }, /exactly one/u],
        ["empty notes", { updates: "## 0.1.18\n\n## 0.1.17\n" }, /are empty/u],
    ]) {
        it(`rejects ${name}`, () => {
            assert.throws(() => prepareGitHubRelease(validRelease(overrides)), message);
        });
    }
});
