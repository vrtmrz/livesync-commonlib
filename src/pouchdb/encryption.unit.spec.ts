import { describe, expect, it } from "vitest";
import { E2EEAlgorithms, type DocumentID, type FilePathWithPrefix, type PlainEntry } from "@lib/common/types";
import { enableEncryption, getConfiguredFunctionsForEncryption } from "./encryption";
import { PouchDB } from "./pouchdb-test";

describe("HKDF encrypted metadata", () => {
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
