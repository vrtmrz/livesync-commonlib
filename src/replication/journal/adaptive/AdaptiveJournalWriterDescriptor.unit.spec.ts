import { describe, expect, it } from "vitest";

import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import {
    decodeAdaptiveJournalWriterDescriptorV1,
    encodeAdaptiveJournalWriterDescriptorV1,
} from "./AdaptiveJournalWriterDescriptor.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

describe("Adaptive Journal writer descriptor v1", () => {
    it.each(["encrypted", "unencrypted"] as const)(
        "round-trips and authenticates the %s logical writer identity",
        async (encryption) => {
            const candidate = await createAdaptiveJournalManifestV1({
                encryption,
                passphrase: encryption === "encrypted" ? "writer descriptor passphrase" : undefined,
                repositoryId: sequence(0x10),
                securitySeed: sequence(0x80),
            });
            const encoded = await encodeAdaptiveJournalWriterDescriptorV1({
                hostId: "host-a",
                iv: new Uint8Array(12).fill(0x40),
                keys: candidate.keys,
                recordSalt: new Uint8Array(32).fill(0x50),
                writerEpoch: "epoch-a",
            });

            await expect(
                decodeAdaptiveJournalWriterDescriptorV1({
                    bytes: encoded.bytes,
                    keys: candidate.keys,
                    writerStreamId: encoded.writerStreamId,
                })
            ).resolves.toEqual({ digest: encoded.digest, payload: encoded.payload });
        }
    );

    it("rejects a descriptor presented through another writer route", async () => {
        const candidate = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const encoded = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "host-a",
            keys: candidate.keys,
            writerEpoch: "epoch-a",
        });
        const other = await encodeAdaptiveJournalWriterDescriptorV1({
            hostId: "host-a",
            keys: candidate.keys,
            writerEpoch: "epoch-b",
        });

        await expect(
            decodeAdaptiveJournalWriterDescriptorV1({
                bytes: encoded.bytes,
                keys: candidate.keys,
                writerStreamId: other.writerStreamId,
            })
        ).rejects.toMatchObject({ code: "invalid-writer-descriptor" });
    });
});
