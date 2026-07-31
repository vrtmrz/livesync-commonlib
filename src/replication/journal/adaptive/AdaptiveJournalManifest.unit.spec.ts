import { describe, expect, it } from "vitest";

import {
    AdaptiveJournalError,
    createAdaptiveJournalManifestV1,
    deriveRemoteChunkKeyV1,
    deriveWriterStreamIdV1,
    parseAndVerifyAdaptiveJournalManifestV1,
} from "./AdaptiveJournalManifest.ts";
import { bytesToBase64Url } from "./AdaptiveJournalBinary.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal manifest v1", () => {
    it("creates canonical authenticated manifests and derives stable repository-scoped identities", async () => {
        const repositoryId = sequence(0x10);
        const securitySeed = sequence(0x80);
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "correct horse battery staple",
            repositoryId,
            securitySeed,
        });

        const text = new TextDecoder().decode(candidate.bytes);
        expect(text).toBe(JSON.stringify(candidate.manifest));
        expect(text.startsWith('{"chunkKeyMode"')).toBe(true);
        expect(text).not.toContain(" ");
        expect(candidate.manifest.repositoryId).toBe(bytesToBase64Url(repositoryId));
        expect(candidate.manifest.securitySeed).toBe(bytesToBase64Url(securitySeed));
        expect(candidate.manifest.objectLayout).toBe("commit-bundle-v1");

        const opened = await parseAndVerifyAdaptiveJournalManifestV1(candidate.bytes, {
            expectedEncryption: "encrypted",
            expectedRepositoryId: bytesToBase64Url(repositoryId),
            passphrase: "correct horse battery staple",
        });
        const firstChunkKey = await deriveRemoteChunkKeyV1(opened.keys, "h:example-chunk");
        const repeatedChunkKey = await deriveRemoteChunkKeyV1(opened.keys, "h:example-chunk");
        const otherChunkKey = await deriveRemoteChunkKeyV1(opened.keys, "h:another-chunk");
        expect(firstChunkKey).toEqual(repeatedChunkKey);
        expect(firstChunkKey).not.toEqual(otherChunkKey);
        expect(firstChunkKey).toHaveLength(32);

        const firstStream = await deriveWriterStreamIdV1(opened.keys, "host-a", "epoch-a");
        const repeatedStream = await deriveWriterStreamIdV1(opened.keys, "host-a", "epoch-a");
        const otherStream = await deriveWriterStreamIdV1(opened.keys, "host-a", "epoch-b");
        expect(firstStream).toEqual(repeatedStream);
        expect(firstStream).not.toEqual(otherStream);
        expect(firstStream).toHaveLength(32);
    });

    it("fails closed for the wrong passphrase, encryption mode, repository ID, or non-canonical bytes", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "encrypted",
            passphrase: "right passphrase",
            repositoryId: sequence(0x20),
            securitySeed: sequence(0xa0),
        });

        await expect(
            parseAndVerifyAdaptiveJournalManifestV1(candidate.bytes, {
                expectedEncryption: "encrypted",
                passphrase: "wrong passphrase",
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "manifest-authentication-failed" });
        await expect(
            parseAndVerifyAdaptiveJournalManifestV1(candidate.bytes, {
                expectedEncryption: "unencrypted",
                passphrase: "",
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "encryption-mode-mismatch" });
        await expect(
            parseAndVerifyAdaptiveJournalManifestV1(candidate.bytes, {
                expectedEncryption: "encrypted",
                expectedRepositoryId: bytesToBase64Url(sequence(0x21)),
                passphrase: "right passphrase",
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "repository-id-mismatch" });

        const nonCanonical = new TextEncoder().encode(JSON.stringify(candidate.manifest, undefined, 2));
        await expect(
            parseAndVerifyAdaptiveJournalManifestV1(nonCanonical, {
                expectedEncryption: "encrypted",
                passphrase: "right passphrase",
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "non-canonical-manifest" });
    });

    it("uses an explicit public integrity mode for unencrypted repositories", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x30),
            securitySeed: sequence(0xc0),
        });
        expect(candidate.manifest.chunkKeyMode).toBe("repository-scoped-sha256");
        expect(candidate.manifest.cipherSuite).toBe("none");

        const opened = await parseAndVerifyAdaptiveJournalManifestV1(candidate.bytes, {
            expectedEncryption: "unencrypted",
            passphrase: "",
        });
        await expect(deriveRemoteChunkKeyV1(opened.keys, "h:public-chunk")).resolves.toHaveLength(32);
    });

    it("detects the superseded experimental object layout and requires a remote Rebuild", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x31),
            securitySeed: sequence(0xc1),
        });
        const superseded = { ...candidate.manifest } as Record<string, unknown>;
        delete superseded.objectLayout;

        await expect(
            parseAndVerifyAdaptiveJournalManifestV1(new TextEncoder().encode(JSON.stringify(superseded)), {
                expectedEncryption: "unencrypted",
                passphrase: "",
            })
        ).rejects.toThrowError(/remote must be rebuilt/u);
    });
});
