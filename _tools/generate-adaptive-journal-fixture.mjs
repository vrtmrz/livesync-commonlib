#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const target = resolve(root, "src/replication/journal/adaptive/fixtures/v1.json");

if (!process.argv.includes("--write")) {
    throw new Error("Pass --write to replace the frozen Adaptive Journal v1 fixture.");
}

let protocol;
try {
    protocol = await import(new URL("../.package/dist/adaptiveJournal.js", import.meta.url));
} catch (error) {
    throw new Error("Run `npm run build:package` before generating the Adaptive Journal fixture.", { cause: error });
}

const {
    ADAPTIVE_JOURNAL_ROLES_V1,
    AdaptiveBatchOperationV1,
    AdaptiveRecordKindV1,
    buildAdaptiveJournalPackV1,
    bytesToBase64Url,
    concatBytes,
    createAdaptiveJournalManifestV1,
    deriveRemoteChunkKeyV1,
    deriveWriterStreamIdV1,
    encodeBatchRequestV1,
    encodeBatchResponseV1,
    encodeCommitEnvelopeV1,
    encodeRecordFrameV1,
    u64be,
} = protocol;

const b64 = (bytes) => bytesToBase64Url(bytes);
const bytes = (start, length = 32) => Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
const text = (value) => new TextEncoder().encode(value);

const repositoryId = bytes(0x10);
const securitySeed = bytes(0x80);
const passphrase = "Adaptive Journal v1 fixture passphrase";
const encrypted = await createAdaptiveJournalManifestV1({
    encryption: "encrypted",
    passphrase,
    repositoryId,
    securitySeed,
});
const unencrypted = await createAdaptiveJournalManifestV1({
    encryption: "unencrypted",
    repositoryId,
    securitySeed,
});

const localChunkId = "h:adaptive-journal-fixture-chunk";
const hostId = "fixture-host";
const writerEpoch = "fixture-epoch-0001";
const logical32 = bytes(0x30);
const logical40 = concatBytes(logical32, u64be(7n));
const kinds = [
    ["chunk", AdaptiveRecordKindV1.Chunk, logical32],
    ["pack-index", AdaptiveRecordKindV1.PackIndex, logical32],
    ["metadata-batch", AdaptiveRecordKindV1.MetadataBatch, logical40],
    ["catalogue-delta", AdaptiveRecordKindV1.CatalogueDelta, logical40],
    ["catalogue-snapshot", AdaptiveRecordKindV1.CatalogueSnapshot, logical32],
    ["writer-descriptor", AdaptiveRecordKindV1.WriterDescriptor, logical32],
    ["commit", AdaptiveRecordKindV1.Commit, logical40],
];

const records = [];
const recordValues = new Map();
for (const [mode, candidate] of [
    ["encrypted", encrypted],
    ["unencrypted", unencrypted],
]) {
    for (const [kindName, kind, logicalKey] of kinds) {
        for (const codec of ["none", "deflate"]) {
            const plaintext =
                codec === "none"
                    ? text(`Adaptive Journal fixture ${mode} ${kindName} none`)
                    : text(`Adaptive Journal fixture ${mode} ${kindName} deflate payload|`.repeat(8));
            const saltStart = 0x20 + kind * 7 + (codec === "deflate" ? 1 : 0);
            const encoded = await encodeRecordFrameV1({
                codec,
                ...(mode === "encrypted"
                    ? {
                          iv: bytes(0x90 + kind + (codec === "deflate" ? 8 : 0), 12),
                          recordSalt: bytes(saltStart),
                      }
                    : {}),
                keys: candidate.keys,
                kind,
                logicalKey,
                plaintext,
            });
            const key = `${mode}:${kindName}:${codec}`;
            recordValues.set(key, { encoded, logicalKey, plaintext });
            records.push({
                codec,
                digest: b64(encoded.digest),
                frame: b64(encoded.bytes),
                kind: kindName,
                logicalKey: b64(logicalKey),
                mode,
                plaintext: b64(plaintext),
            });
        }
    }
}

const firstKey = bytes(0x41);
const secondKey = bytes(0x61);
const batchFrame = recordValues.get("unencrypted:chunk:none").encoded;
const batches = {
    getRequest: b64(
        encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Get,
            entries: [{ key: secondKey }, { key: firstKey }],
        })
    ),
    getResponse: b64(
        encodeBatchResponseV1({
            operation: AdaptiveBatchOperationV1.Get,
            entries: [
                { status: "missing" },
                { status: "found", frame: batchFrame.bytes, frameDigest: batchFrame.digest },
            ],
        })
    ),
    hasRequest: b64(
        encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ key: firstKey }, { key: secondKey }],
        })
    ),
    hasResponse: b64(
        encodeBatchResponseV1({
            operation: AdaptiveBatchOperationV1.Has,
            entries: [{ status: "missing" }, { status: "present" }],
        })
    ),
    putRequest: b64(
        encodeBatchRequestV1({
            operation: AdaptiveBatchOperationV1.Put,
            entries: [{ key: firstKey, frame: batchFrame.bytes, frameDigest: batchFrame.digest }],
        })
    ),
    putResponse: b64(
        encodeBatchResponseV1({
            operation: AdaptiveBatchOperationV1.Put,
            entries: [
                { status: "inserted" },
                { status: "exact-existing" },
                { status: "validate-existing" },
            ],
        })
    ),
};

const writerStreamId = await deriveWriterStreamIdV1(encrypted.keys, hostId, writerEpoch);
const commitFrame = recordValues.get("encrypted:commit:deflate").encoded.bytes;
const commit = await encodeCommitEnvelopeV1({
    commitFrame,
    metadataDigest: bytes(0xd0),
    previousCommitDigest: bytes(0xb0),
    repositoryId,
    requiredChunkKeys: [secondKey, firstKey, secondKey],
    sequence: 7n,
    writerStreamId,
});

const packFirstKey = logical32;
const packSecondKey = bytes(0x50);
const packFirst = recordValues.get("unencrypted:chunk:none").encoded;
const packSecond = await encodeRecordFrameV1({
    codec: "deflate",
    keys: unencrypted.keys,
    kind: AdaptiveRecordKindV1.Chunk,
    logicalKey: packSecondKey,
    plaintext: text("Adaptive Journal pack fixture second Chunk|".repeat(8)),
});
const pack = await buildAdaptiveJournalPackV1({
    chunks: [
        { key: packSecondKey, frame: packSecond.bytes },
        { key: packFirstKey, frame: packFirst.bytes },
    ],
    keys: unencrypted.keys,
});

const fixture = {
    format: "adaptive-journal-v1-fixture",
    formatVersion: 1,
    inputs: {
        firstKey: b64(firstKey),
        hostId,
        localChunkId,
        passphrase,
        repositoryId: b64(repositoryId),
        secondKey: b64(secondKey),
        securitySeed: b64(securitySeed),
        writerEpoch,
    },
    manifests: {
        encrypted: {
            bytes: b64(encrypted.bytes),
            digest: b64(encrypted.digest),
            manifest: encrypted.manifest,
        },
        unencrypted: {
            bytes: b64(unencrypted.bytes),
            digest: b64(unencrypted.digest),
            manifest: unencrypted.manifest,
        },
    },
    keySchedule: {
        encryptedRemoteChunkKey: b64(await deriveRemoteChunkKeyV1(encrypted.keys, localChunkId)),
        encryptedRoleKeys: Object.fromEntries(
            ADAPTIVE_JOURNAL_ROLES_V1.map((role) => [role, b64(encrypted.keys.roleKeys.get(role))])
        ),
        encryptedWriterStreamId: b64(writerStreamId),
        unencryptedRemoteChunkKey: b64(await deriveRemoteChunkKeyV1(unencrypted.keys, localChunkId)),
        unencryptedWriterStreamId: b64(
            await deriveWriterStreamIdV1(unencrypted.keys, hostId, writerEpoch)
        ),
    },
    records,
    batches,
    commit: {
        commitFrameDigest: b64(commit.commitFrameDigest),
        digest: b64(commit.digest),
        envelope: b64(commit.bytes),
        metadataDigest: b64(bytes(0xd0)),
        previousCommitDigest: b64(bytes(0xb0)),
        requiredChunkKeys: commit.requiredChunkKeys.map(b64),
        requiredChunkKeysDigest: b64(commit.requiredChunkKeysDigest),
        sequence: "7",
        writerStreamId: b64(writerStreamId),
    },
    pack: {
        entries: pack.entries.map((entry) => ({
            frameDigest: b64(entry.frameDigest),
            frameLength: entry.frameLength,
            key: b64(entry.key),
            offset: entry.offset,
            plaintextLength: entry.plaintextLength,
        })),
        indexFrame: b64(pack.indexFrame),
        indexFrameDigest: b64(pack.indexFrameDigest),
        packBytes: b64(pack.packBytes),
        packId: b64(pack.packId),
    },
};

await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${target}`);
