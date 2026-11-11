import { readAsBlob } from "@lib/common/utils";
import { describe, expect, it, vi } from "vitest";
import {
    E2EEAlgorithms,
    type DocumentID,
    type EntryDoc,
    type EntryLeaf,
    type FilePathWithPrefix,
    type PlainEntry,
} from "@lib/common/types";
import { enableEncryption, getConfiguredFunctionsForEncryption } from "./encryption";
import { PouchDB } from "./pouchdb-test";
import { path2id_base } from "@lib/string_and_binary/path";
import { encryptV1 } from "octagonal-wheels/encryption/index.js";
import { UnencryptedContentRejectedError } from "@lib/replication/UnencryptedContentRejectedError.ts";

describe("HKDF encrypted metadata", () => {
    it.each([
        { data: ["plaintext with a non-string suffix ", 1] },
        { data: 123 },
        { data: { text: "coercible object" } },
        { data: null },
    ])("rejects legacy content which the text reader coerces from JSON ($data)", async ({ data }) => {
        const document = {
            _id: "legacy-coercible-note" as DocumentID,
            type: "notes",
            path: "coercible-note.md" as FilePathWithPrefix,
            data,
        } as unknown as EntryDoc;
        // Legacy Metadata preserves its data field; the text reader constructs a Blob from it.
        const readable = await readAsBlob(document as never).text();
        expect(readable.length).toBeGreaterThan(0);
        for (const algorithm of [E2EEAlgorithms.V2, E2EEAlgorithms.ForceV1]) {
            const configure = (accept: boolean) =>
                getConfiguredFunctionsForEncryption(
                    "coercible-content-policy-secret",
                    false,
                    false,
                    async () => new Uint8Array(16),
                    algorithm,
                    false,
                    undefined,
                    accept
                );
            await expect(configure(false).outgoing(document)).rejects.toMatchObject({
                code: "UNENCRYPTED_CONTENT_REJECTED",
                contentKind: "inline-note",
            });
            await expect(configure(true).outgoing(document)).resolves.toMatchObject(document);
        }
    });

    it("rejects unencrypted chunk content by default with a typed reason", async () => {
        const { outgoing } = getConfiguredFunctionsForEncryption(
            "plaintext-content-policy-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2
        );
        const injectedPlaintext = {
            _id: "h:+injected-plaintext" as DocumentID,
            _rev: "1-injected",
            type: "leaf",
            data: "injected plaintext",
        } as EntryDoc;

        await expect(outgoing(injectedPlaintext)).rejects.toMatchObject({
            name: "UnencryptedContentRejectedError",
            code: "UNENCRYPTED_CONTENT_REJECTED",
            documentId: injectedPlaintext._id,
            contentKind: "chunk",
        });
    });

    it.each([
        { _id: "f:legacy-note", type: "notes", data: "legacy plaintext", contentKind: "inline-note" },
        { _id: "f:missing-type", data: "plaintext without a type", contentKind: "inline-note" },
        { _id: "h:legacy-chunk", type: "leaf", data: "legacy chunk plaintext", contentKind: "chunk" },
        { _id: "opaque-leaf", type: "leaf", data: "leaf plaintext", contentKind: "chunk" },
        { _id: "f:metadata-with-body", type: "plain", data: "unexpected readable body", contentKind: "inline-note" },
        { _id: "f:pack-body", type: "chunkpack", data: "chunk pack body", contentKind: "chunk" },
    ] as const)("rejects readable plaintext shape $type at $._id", async (document) => {
        const { outgoing } = getConfiguredFunctionsForEncryption(
            "plaintext-shape-policy-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2
        );

        await expect(outgoing(document as EntryDoc)).rejects.toMatchObject({
            name: "UnencryptedContentRejectedError",
            documentId: document._id,
            contentKind: document.contentKind,
        });
    });

    it.each(["plain", "versioninfo", "chunkpack"])(
        "does not let a h: chunk use forged type %s to bypass the plaintext guard",
        async (type) => {
            const { outgoing } = getConfiguredFunctionsForEncryption(
                "forged-chunk-type-policy-secret",
                false,
                false,
                async () => new Uint8Array(16),
                E2EEAlgorithms.V2
            );
            const chunk = {
                _id: "h:+forged-type" as DocumentID,
                type,
                data: "plaintext chunk content",
            } as EntryDoc;

            await expect(outgoing(chunk)).rejects.toMatchObject({
                name: "UnencryptedContentRejectedError",
                documentId: chunk._id,
                contentKind: "chunk",
            });
        }
    );

    it("rejects plaintext Eden even when the chunk body is marked encrypted", async () => {
        const { outgoing } = getConfiguredFunctionsForEncryption(
            "mixed-chunk-eden-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2
        );
        const mixed = {
            _id: "h:+mixed-eden" as DocumentID,
            type: "leaf",
            e_: true,
            data: "%=ciphertext-placeholder",
            eden: { "h:plaintext-eden": { data: "plaintext Eden", epoch: 1 } },
        } as unknown as EntryDoc;

        await expect(outgoing(mixed)).rejects.toMatchObject({
            name: "UnencryptedContentRejectedError",
            documentId: mixed._id,
            contentKind: "eden",
        });
    });

    it("rejects plaintext Eden by default and accepts it only with the explicit option", async () => {
        const document = {
            _id: "f:plaintext-eden" as DocumentID,
            type: "plain",
            path: "eden.md",
            children: ["h:plaintext-eden"],
            eden: { "h:plaintext-eden": { data: "plaintext Eden", epoch: 1 } },
        } as EntryDoc;
        const strictReader = getConfiguredFunctionsForEncryption(
            "plaintext-eden-policy-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2
        );
        const acceptingReader = getConfiguredFunctionsForEncryption(
            "plaintext-eden-opt-in-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2,
            false,
            undefined,
            true
        );

        await expect(strictReader.outgoing(document)).rejects.toMatchObject({ contentKind: "eden" });
        await expect(acceptingReader.outgoing(document)).resolves.toMatchObject(document);
    });

    it("rejects plaintext Eden mixed with a recognised encrypted Eden marker", async () => {
        const salt = new Uint8Array(16).fill(3);
        const source = {
            _id: "f:mixed-eden" as DocumentID,
            type: "plain",
            path: "mixed-eden.md",
            ctime: 1,
            mtime: 2,
            size: 3,
            children: ["h:encrypted-eden"],
            eden: { "h:encrypted-eden": { data: "encrypted Eden value", epoch: 1 } },
        } as PlainEntry;
        const writer = getConfiguredFunctionsForEncryption(
            "mixed-eden-content-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const encrypted = await writer.incoming(source);
        const mixed = {
            ...encrypted,
            eden: {
                ...("eden" in encrypted ? encrypted.eden : {}),
                "h:plaintext-eden": { data: "plaintext Eden value", epoch: 2 },
            },
        } as EntryDoc;
        const reader = getConfiguredFunctionsForEncryption(
            "mixed-eden-content-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );

        await expect(reader.outgoing(mixed)).rejects.toMatchObject({ contentKind: "eden" });
    });

    it("continues to decrypt Eden encrypted by the existing writer", async () => {
        const salt = new Uint8Array(16).fill(4);
        const document = {
            _id: "f:encrypted-eden" as DocumentID,
            path: "encrypted-eden.md" as FilePathWithPrefix,
            type: "plain",
            ctime: 10,
            mtime: 20,
            size: 30,
            children: [],
            eden: { "h:encrypted-eden": { data: "private Eden value", epoch: 1 } },
        } satisfies PlainEntry;
        const writer = getConfiguredFunctionsForEncryption(
            "encrypted-eden-roundtrip-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const reader = getConfiguredFunctionsForEncryption(
            "encrypted-eden-roundtrip-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const encrypted = await writer.incoming(document);

        await expect(reader.outgoing(encrypted as EntryDoc)).resolves.toMatchObject(document);
    });

    it.each([false, true])(
        "keeps empty Metadata, empty Eden, control documents, and tombstones readable (accept=%s)",
        async (accept) => {
            const { outgoing } = getConfiguredFunctionsForEncryption(
                "plaintext-exempt-shapes-secret",
                false,
                false,
                async () => new Uint8Array(16),
                E2EEAlgorithms.V2,
                false,
                undefined,
                accept
            );
            const cases = [
                { _id: "f:metadata", type: "plain", path: "note.md", children: [], eden: {} },
                { _id: "obsydian_livesync_version", type: "versioninfo", data: "control payload" },
                { _id: "f:soft-deleted", type: "plain", path: "soft-deleted.md", data: "unused body", deleted: true },
                { _id: "h:+deleted", type: "leaf", data: "unused tombstone body", _deleted: true },
            ] as EntryDoc[];

            for (const document of cases) await expect(outgoing(document)).resolves.toMatchObject(document);
        }
    );

    it("requires the matching type before exempting a known control document ID", async () => {
        const { outgoing } = getConfiguredFunctionsForEncryption(
            "control-id-type-policy-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2
        );
        const genuineControl = {
            _id: "syncinfo" as DocumentID,
            type: "syncinfo",
            data: "control payload",
        } as EntryDoc;
        const forgedControl = {
            _id: "syncinfo" as DocumentID,
            type: "leaf",
            data: "plaintext body read as a chunk",
        } as EntryDoc;

        await expect(outgoing(genuineControl)).resolves.toMatchObject(genuineControl);
        await expect(outgoing(forgedControl)).rejects.toMatchObject({
            name: "UnencryptedContentRejectedError",
            documentId: forgedControl._id,
            contentKind: "chunk",
        });
    });

    it("accepts plaintext file content only when the explicit option is true", async () => {
        const document = {
            _id: "h:+accepted-plaintext" as DocumentID,
            type: "leaf",
            data: "accepted plaintext",
        } as EntryDoc;
        const acceptingReader = getConfiguredFunctionsForEncryption(
            "plaintext-content-opt-in-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2,
            false,
            undefined,
            true
        );
        // Simulate an untyped caller so the runtime opt-in check remains covered.
        const invalidOptionReader = Reflect.apply(getConfiguredFunctionsForEncryption, undefined, [
            "plaintext-content-invalid-option-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.V2,
            false,
            undefined,
            "true",
        ]);

        await expect(acceptingReader.outgoing(document)).resolves.toMatchObject(document);
        await expect(invalidOptionReader.outgoing(document)).rejects.toBeInstanceOf(UnencryptedContentRejectedError);
    });

    it("continues to decrypt correctly encrypted chunks and rejects wrong keys", async () => {
        const passphrase = "encrypted-chunk-policy-secret";
        const salt = new Uint8Array(16).fill(7);
        const document = {
            _id: "h:+encrypted-policy" as DocumentID,
            type: "leaf",
            data: "authenticated encrypted content",
        } as EntryDoc;
        const writer = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const encrypted = await writer.incoming(document);
        const reader = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const wrongKeyReader = getConfiguredFunctionsForEncryption(
            "wrong-encrypted-chunk-policy-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2,
            false,
            undefined,
            true
        );

        await expect(reader.outgoing(encrypted as EntryDoc)).resolves.toMatchObject(document);
        await expect(wrongKeyReader.outgoing(encrypted as EntryDoc)).rejects.toThrow();
    });

    it("keeps supported ForceV1 markerless ciphertext decryptable without wrong-key or corruption fallback", async () => {
        const passphrase = "legacy-markerless-policy-secret";
        const salt = new Uint8Array(16).fill(8);
        const document = {
            _id: "h:+markerless-v1" as DocumentID,
            type: "leaf",
            data: "legacy ciphertext body",
        } as EntryDoc;
        const writer = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.ForceV1
        );
        const reader = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.ForceV1
        );
        const wrongKeyReader = getConfiguredFunctionsForEncryption(
            "wrong-markerless-policy-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.ForceV1,
            false,
            undefined,
            true
        );
        const acceptingReader = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.ForceV1,
            false,
            undefined,
            true
        );
        const currentCiphertext = await writer.incoming(document);
        const currentMarkerless = { ...currentCiphertext } as EntryLeaf;
        delete (currentMarkerless as unknown as Record<string, unknown>).e_;
        const legacyData = await encryptV1("legacy ciphertext body", passphrase, false);
        const legacyMarkerless = { ...document, data: legacyData } as EntryDoc;
        const corruptedData = `${currentMarkerless.data.slice(0, 65)}${currentMarkerless.data[65] === "A" ? "B" : "A"}${currentMarkerless.data.slice(66)}`;
        const corruptedMarkerless = { ...currentMarkerless, data: corruptedData };

        expect(currentMarkerless.data.startsWith("%")).toBe(true);
        expect(legacyData.startsWith("[")).toBe(true);
        await expect(reader.outgoing(currentMarkerless)).resolves.toMatchObject(document);
        await expect(reader.outgoing(legacyMarkerless)).resolves.toMatchObject(document);
        await expect(wrongKeyReader.outgoing(currentMarkerless)).rejects.toThrow();
        await expect(acceptingReader.outgoing(corruptedMarkerless)).rejects.toThrow();
    });

    it("accepts ordinary bracketed and percent-prefixed plaintext only when enabled", async () => {
        const reader = getConfiguredFunctionsForEncryption(
            "ordinary-plaintext-header-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.ForceV1,
            false,
            undefined,
            true
        );
        const documents = [
            { _id: "h:+plain-json-array" as DocumentID, type: "leaf", data: '["note", "not-hex", "not-hex"]' },
            { _id: "h:+plain-percent" as DocumentID, type: "leaf", data: "% ordinary plaintext" },
        ] as EntryDoc[];

        for (const document of documents) await expect(reader.outgoing(document)).resolves.toMatchObject(document);
    });

    it("rejects an unsupported encrypted Eden form under ForceV1 even when plaintext is enabled", async () => {
        const reader = getConfiguredFunctionsForEncryption(
            "unsupported-eden-algorithm-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.ForceV1,
            false,
            undefined,
            true
        );
        const document = {
            _id: "f:unsupported-eden" as DocumentID,
            type: "plain",
            eden: { "h:++encrypted-hkdf": { data: "%=ciphertext", epoch: 1 } },
        } as EntryDoc;

        await expect(reader.outgoing(document)).rejects.toThrow(
            "Encrypted Eden uses a representation which this E2EE reader cannot decrypt."
        );
    });

    it("does not trust an e_ marker when ForceV1 has no matching data decrypt branch", async () => {
        const { outgoing } = getConfiguredFunctionsForEncryption(
            "forged-e2ee-marker-secret",
            false,
            false,
            async () => new Uint8Array(16),
            E2EEAlgorithms.ForceV1,
            false,
            undefined,
            true
        );
        const forgedMarker = {
            _id: "note:ordinary-id" as DocumentID,
            type: "notes",
            e_: true,
            data: "plaintext that this branch does not decrypt",
        } as EntryDoc;

        await expect(outgoing(forgedMarker)).rejects.toThrow(
            "Encrypted file content uses a representation which this E2EE reader cannot decrypt."
        );
    });

    it.each(["i:", "ix:", "ps:"] as const)(
        "does not newly encrypt %s Metadata when internal Metadata protection is disabled",
        async (prefix) => {
            const salt = new Uint8Array(16);
            const getSalt = vi.fn(async () => salt);
            const passphrase = "internal-metadata-disabled-secret";
            const path = `${prefix}.obsidian/private.json` as FilePathWithPrefix;
            const document: PlainEntry = {
                _id: await path2id_base(path, passphrase, false),
                path,
                type: "plain",
                ctime: 10,
                mtime: 20,
                size: 30,
                children: ["h:+private-chunk"],
                eden: {},
            };
            const { incoming } = getConfiguredFunctionsForEncryption(
                passphrase,
                false,
                false,
                getSalt,
                E2EEAlgorithms.V2
            );

            await expect(incoming(document)).resolves.toEqual(document);
            expect(getSalt).not.toHaveBeenCalled();
        }
    );

    it.each(["i:", "ix:", "ps:"] as const)(
        "encrypts and restores %s Metadata when internal Metadata protection is enabled",
        async (prefix) => {
            const salt = new Uint8Array(16);
            const passphrase = "internal-metadata-round-trip-secret";
            const path = `${prefix}.obsidian/private.json` as FilePathWithPrefix;
            const document: PlainEntry = {
                _id: await path2id_base(path, passphrase, false),
                path,
                type: "plain",
                ctime: 10,
                mtime: 20,
                size: 30,
                children: ["h:+private-chunk"],
                eden: {},
            };
            const writer = getConfiguredFunctionsForEncryption(
                passphrase,
                false,
                false,
                async () => salt,
                E2EEAlgorithms.V2,
                true
            );
            const readerWithPreferenceOff = getConfiguredFunctionsForEncryption(
                passphrase,
                false,
                false,
                async () => salt,
                E2EEAlgorithms.V2
            );

            const encrypted = await writer.incoming(document);
            expect(encrypted).toMatchObject({
                _id: document._id,
                ctime: 0,
                mtime: 0,
                size: 0,
                children: [],
            });
            expect("path" in encrypted && encrypted.path.startsWith("/\\:")).toBe(true);
            expect(JSON.stringify(encrypted)).not.toContain(path);
            await expect(readerWithPreferenceOff.outgoing(encrypted)).resolves.toMatchObject(document);
        }
    );

    it("restores an obfuscated document from its encrypted metadata path", async () => {
        const salt = new Uint8Array(16);
        const { incoming, outgoing } = getConfiguredFunctionsForEncryption(
            "metadata-round-trip-secret",
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        const document: PlainEntry = {
            _id: `f:${"a".repeat(64)}` as DocumentID,
            path: "Folder/Poem: Example.md" as FilePathWithPrefix,
            type: "plain",
            ctime: 10,
            mtime: 20,
            size: 30,
            children: ["h:example"],
            eden: {},
        };

        const encrypted = await incoming(document);
        expect("path" in encrypted && encrypted.path.startsWith("/\\:")).toBe(true);
        expect(encrypted).toMatchObject({ _id: document._id, ctime: 0, mtime: 0, size: 0, children: [] });

        await expect(outgoing(encrypted)).resolves.toMatchObject(document);
    });

    it("continues to decode legacy V1 obfuscated paths", async () => {
        const passphrase = "legacy-path-secret";
        const salt = new Uint8Array(16);
        const document: PlainEntry = {
            _id: `f:${"b".repeat(64)}` as DocumentID,
            path: "legacy.md" as FilePathWithPrefix,
            type: "plain",
            ctime: 10,
            mtime: 20,
            size: 30,
            children: ["h:example"],
            eden: {},
        };
        const oldWriter = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V1
        );
        const currentReader = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );

        const encrypted = await oldWriter.incoming(document);
        expect("path" in encrypted && encrypted.path !== document.path).toBe(true);
        await expect(currentReader.outgoing(encrypted)).resolves.toMatchObject(document);
    });

    it("passes decrypted metadata to local replication and its change event", async () => {
        const remoteName = `encrypted-remote-${crypto.randomUUID()}`;
        const localName = `encrypted-local-${crypto.randomUUID()}`;
        const rawRemote = new PouchDB(remoteName, { adapter: "memory" });
        const local = new PouchDB(localName, { adapter: "memory" });
        try {
            const salt = new Uint8Array(16);
            const passphrase = "replication-metadata-secret";
            const { incoming } = getConfiguredFunctionsForEncryption(
                passphrase,
                false,
                false,
                async () => salt,
                E2EEAlgorithms.V2
            );
            const document: PlainEntry = {
                _id: `f:${"c".repeat(64)}` as DocumentID,
                path: "Folder/Poem: Example.md" as FilePathWithPrefix,
                type: "plain",
                ctime: 10,
                mtime: 20,
                size: 30,
                children: [],
                eden: {},
            };
            const encrypted = await incoming(document);
            await rawRemote.put(encrypted);
            expect((await rawRemote.get(document._id)).path).toMatch(/^\/\\:/);

            enableEncryption(rawRemote, passphrase, false, false, async () => salt, E2EEAlgorithms.V2);
            const changedPaths: string[] = [];
            await local.replicate.from(rawRemote).on("change", (change) => {
                changedPaths.push(...change.docs.map((doc) => ("path" in doc ? String(doc.path) : "")));
            });

            expect((await local.get(document._id)).path).toBe(document.path);
            expect(changedPaths).toEqual([document.path]);
        } finally {
            await local.destroy();
            await rawRemote.destroy();
        }
    });
});

describe("Repeated encrypted content receipt", () => {
    const passphrase = "repeated-chunk-policy-secret";
    const salt = new Uint8Array(16).fill(7);
    const source = {
        _id: "h:+shared-content" as DocumentID,
        _rev: "1-encrypted",
        type: "leaf",
        data: "Content shared by two files. ".repeat(1024),
    } as EntryLeaf;

    function configure(algorithm: (typeof E2EEAlgorithms)[keyof typeof E2EEAlgorithms]) {
        return getConfiguredFunctionsForEncryption(passphrase, false, false, async () => salt, algorithm);
    }

    it.each([
        { algorithm: E2EEAlgorithms.V2, markerless: false },
        { algorithm: E2EEAlgorithms.ForceV1, markerless: false },
        { algorithm: E2EEAlgorithms.ForceV1, markerless: true },
    ])(
        "reuses $algorithm ciphertext without mutating it or trusting its ID (markerless=$markerless)",
        async ({ algorithm, markerless }) => {
            const encrypted = (await configure(algorithm).incoming(source)) as EntryLeaf & { e_?: boolean };
            if (markerless) delete encrypted.e_;
            const wireSnapshot = structuredClone(encrypted);
            const reader = configure(algorithm);

            for (let read = 0; read < 3; read++) {
                expect((await reader.outgoing(encrypted)).data).toBe(source.data);
            }
            const sharedReads = await Promise.all([reader.outgoing(encrypted), reader.outgoing(encrypted)]);
            expect(sharedReads.map((entry) => entry.data)).toEqual([source.data, source.data]);
            expect(encrypted).toEqual(wireSnapshot);
            await expect(reader.outgoing({ ...source, _rev: "2-plaintext" })).rejects.toMatchObject({
                code: "UNENCRYPTED_CONTENT_REJECTED",
                documentId: source._id,
            });
        }
    );

    it.each([
        { markerless: false, maximumPayloadChecks: 0 },
        { markerless: true, maximumPayloadChecks: 1 },
    ])(
        "bounds payload validation work for ForceV1 receipt (markerless=$markerless)",
        async ({ markerless, maximumPayloadChecks }) => {
            const encrypted = (await configure(E2EEAlgorithms.ForceV1).incoming(source)) as EntryLeaf & {
                e_?: boolean;
            };
            if (markerless) delete encrypted.e_;
            const reader = configure(E2EEAlgorithms.ForceV1);
            const originalTest = RegExp.prototype.test;
            let payloadChecks = 0;
            // Count large validation operands instead of asserting machine-dependent elapsed time.
            // Keep the real authenticated decryptor in the path and exclude fixed-size header checks.
            const regexpTest = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (
                this: RegExp,
                value: string
            ) {
                if (value.length >= encrypted.data.length - 65) payloadChecks++;
                return originalTest.call(this, value);
            });
            let decrypted: Awaited<ReturnType<typeof reader.outgoing>>;
            try {
                decrypted = await reader.outgoing(encrypted);
            } finally {
                regexpTest.mockRestore();
            }
            expect(decrypted.data).toBe(source.data);
            expect(payloadChecks).toBeLessThanOrEqual(maximumPayloadChecks);
        }
    );

    it("parses the markerless legacy envelope once per receipt", async () => {
        const encrypted = { ...source, data: await encryptV1(source.data, passphrase, false) };
        const reader = configure(E2EEAlgorithms.ForceV1);
        const originalParse = JSON.parse;
        let envelopeParses = 0;
        const parse = vi.spyOn(JSON, "parse").mockImplementation((...args) => {
            if (args[0] === encrypted.data) envelopeParses++;
            return originalParse(...args);
        });
        let decrypted: Awaited<ReturnType<typeof reader.outgoing>>;
        try {
            decrypted = await reader.outgoing(encrypted);
        } finally {
            parse.mockRestore();
        }
        expect(decrypted.data).toBe(source.data);
        expect(envelopeParses).toBe(1);
    });
});

describe("ForceV1 encrypted entry shape", () => {
    const passphrase = "encrypted-entry-shape-secret";
    const salt = new Uint8Array(16).fill(9);

    it.each([undefined, null, 42, ["plaintext"], { text: "plaintext" }])(
        "rejects a marked non-string body instead of skipping decryption (%j)",
        async (data) => {
            const eden = {
                "h:++encrypted": {
                    data: await encryptV1(
                        JSON.stringify({ "h:child": { data: "Eden content", epoch: 1 } }),
                        passphrase,
                        false
                    ),
                    epoch: 1,
                },
            };
            const shapes = [
                { _id: "h:+invalid-body", type: "leaf" },
                { _id: "f:invalid-body", type: "notes", path: "legacy.md" },
                { _id: "note:invalid-body", type: "notes", path: "eden.md", eden },
            ];
            for (const accept of [false, true]) {
                const reader = getConfiguredFunctionsForEncryption(
                    passphrase,
                    false,
                    false,
                    async () => salt,
                    E2EEAlgorithms.ForceV1,
                    false,
                    undefined,
                    accept
                );
                for (const shape of shapes) {
                    await expect(reader.outgoing({ ...shape, e_: true, data } as EntryDoc)).rejects.toThrow();
                }
            }
        }
    );

    it.each([false, true])(
        "decrypts marked legacy inline bodies with the existing fallback (dynamic=%s)",
        async (dynamic) => {
            const plaintext = "A legacy inline body";
            const data = await encryptV1(plaintext, passphrase, false);
            const eden = {
                "h:++encrypted": {
                    data: await encryptV1(
                        JSON.stringify({ "h:child": { data: "Eden content", epoch: 1 } }),
                        passphrase,
                        false
                    ),
                    epoch: 1,
                },
            };
            const reader = getConfiguredFunctionsForEncryption(
                passphrase,
                dynamic,
                false,
                async () => salt,
                E2EEAlgorithms.ForceV1
            );
            const shapes = [
                { _id: "f:legacy-inline", type: "notes", path: "legacy.md" },
                { _id: "note:legacy-inline", type: "notes", path: "eden.md", eden },
            ];
            for (const shape of shapes) {
                const encrypted = { ...shape, e_: true, data } as EntryDoc;
                const snapshot = structuredClone(encrypted);
                const result = await reader.outgoing(encrypted);
                expect(result.data).toBe(plaintext);
                if (shape.eden)
                    expect("eden" in result && result.eden).toEqual({ "h:child": { data: "Eden content", epoch: 1 } });
                expect(encrypted).toEqual(snapshot);
            }
        }
    );
});
