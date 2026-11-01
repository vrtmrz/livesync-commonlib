import { describe, expect, it } from "vitest";
import { DOCID_SYNC_PARAMETERS, VERSIONING_DOCID, type EntryDoc, type EntryLeaf, type FilePathWithPrefix } from "@lib/common/types.ts";
import { PouchDB } from "@lib/pouchdb/pouchdb-http.ts";
import { DirectFileManipulator, type DirectFileManipulatorOptions } from "./DirectFileManipulatorV2.ts";

const url = process.env.hostname ?? "http://127.0.0.1:5989/";
const username = process.env.username ?? "admin";
const password = process.env.password ?? "testpassword";
const firstKey = "ab".repeat(32);
const differentKey = "cd".repeat(32);

describe("direct CouchDB access with an independent ID key", () => {
    it("reads data with the same key and rejects a different key before changing control documents", async () => {
        const database = "direct-id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const options: DirectFileManipulatorOptions = {
            url,
            username,
            password,
            database,
            passphrase: "direct-integration-passphrase",
            obfuscatePassphrase: "direct-integration-passphrase",
            idDerivationVersion: 1,
            idDerivationKey: firstKey,
        };
        const remote = new PouchDB<EntryDoc>(url.replace(/\/$/u, "") + "/" + database, {
            auth: { username, password },
        });
        const manipulators: DirectFileManipulator[] = [];
        const create = (candidate: DirectFileManipulatorOptions) => {
            const manipulator = new DirectFileManipulator(candidate);
            manipulators.push(manipulator);
            return manipulator;
        };
        const path = "notes/one.md" as FilePathWithPrefix;

        try {
            const first = create(options);
            await first.ready.promise;
            const now = Date.now();
            await expect(first.put(path, ["one known note"], { ctime: now, mtime: now, size: 14 })).resolves.toBe(true);
            const documentId = await first.path2id(path);
            expect(documentId).toMatch(/^f:[0-9a-f]{64}$/u);
            const raw = await remote.get(documentId);
            expect(raw._id).toBe(documentId);
            expect(raw.path).not.toBe(path);

            const matching = create(options);
            await matching.ready.promise;
            expect(await matching.path2id(path)).toBe(documentId);
            expect(await matching.get(path)).toMatchObject({ path, data: ["one known note"] });
            const beforeMismatch = await remote.get(VERSIONING_DOCID);

            for (const idSettings of [
                { idDerivationVersion: 1 as const, idDerivationKey: differentKey },
                { idDerivationVersion: 0 as const, idDerivationKey: "" },
            ]) {
                const different = create({ ...options, ...idSettings });
                await expect(different.ready.promise).rejects.toThrow("document IDs do not match");
                expect(await remote.get(VERSIONING_DOCID)).toEqual(beforeMismatch);
                expect(await remote.get(documentId)).toEqual(raw);
            }
        } finally {
            for (const manipulator of manipulators) {
                await manipulator.close().catch(() => undefined);
            }
            await remote.destroy();
        }
    });
});

describe("direct CouchDB access with encrypted late chunks", () => {
    it("delivers chunks arriving after their metadata decrypted", async () => {
        const database = "direct-late-" + Date.now() + "-" + Math.random().toString(36).slice(2);
        const options: DirectFileManipulatorOptions = {
            url,
            username,
            password,
            database,
            passphrase: "late-chunk-integration-passphrase",
            obfuscatePassphrase: "late-chunk-integration-passphrase",
            idDerivationVersion: 1,
            idDerivationKey: firstKey,
            useEden: false,
        };
        const source = new PouchDB<EntryDoc>(url.replace(/\/$/u, "") + "/" + database, {
            auth: { username, password },
        });
        const destination = new PouchDB<EntryDoc>(url.replace(/\/$/u, "") + "/" + database + "-reader", {
            auth: { username, password },
        });
        const writer = new DirectFileManipulator(options);
        let reader: DirectFileManipulator | undefined;
        let unsubscribe: (() => void) | undefined;
        const path = "notes/late-chunks.md" as FilePathWithPrefix;
        const text = Array.from({ length: 1500 }, (_, index) => `Line ${index}: known synthetic note content.\n`).join("");

        try {
            await writer.ready.promise;
            const now = Date.now();
            await expect(writer.put(path, text, { ctime: now, mtime: now, size: text.length })).resolves.toBe(true);
            const documents = (await source.allDocs({ include_docs: true })).rows.flatMap((row) =>
                row.doc && !row.id.startsWith("_design/") ? [row.doc] : []
            );
            const chunks = documents.filter((doc): doc is EntryLeaf => doc.type === "leaf");
            expect(chunks.length).toBeGreaterThan(1);
            for (const chunk of chunks) {
                expect(chunk).toMatchObject({ e_: true });
                expect(chunk.data).toMatch(/^%=/u);
            }

            // CouchDB excludes the local encryption parameters from allDocs and replication.
            const { _rev: sourceRevision, ...parameters } = await source.get(DOCID_SYNC_PARAMETERS);
            await destination.put(parameters);
            const metadataResults = await destination.bulkDocs(documents.filter((doc) => doc.type !== "leaf"), {
                new_edits: false,
            });
            expect(metadataResults.every((result) => !("error" in result))).toBe(true);
            reader = new DirectFileManipulator({ ...options, database: database + "-reader" });
            await reader.ready.promise;
            const metadata = await reader.get(path, true);
            if (!metadata || !("children" in metadata)) throw new Error("The note metadata is missing.");
            expect(metadata.children.length).toBeGreaterThan(1);
            const chunkIds = new Set(chunks.map((chunk) => chunk._id));
            expect(metadata.children.every((id) => chunkIds.has(id))).toBe(true);

            const arrived = new Map<string, EntryLeaf>();
            const onChange = (change: PouchDB.Core.ChangesResponseChange<EntryDoc>) => {
                if (change.doc?.type === "leaf" && chunkIds.has(change.doc._id)) {
                    arrived.set(change.doc._id, change.doc);
                }
            };
            unsubscribe = reader.liveSyncLocalDB.managers.changeManager.addCallback(onChange);
            const chunkResults = await destination.bulkDocs(chunks, { new_edits: false });
            expect(chunkResults.every((result) => !("error" in result))).toBe(true);
            await expect.poll(() => arrived.size, { timeout: 5000 }).toBe(chunks.length);

            for (const chunk of arrived.values()) {
                expect(chunk).not.toMatchObject({ e_: true });
                expect(chunk.data).not.toMatch(/^%=/u);
            }
            expect(metadata.children.map((id) => arrived.get(id)?.data).join("")).toBe(text);
            const note = await reader.get(path);
            if (!note || !("data" in note)) throw new Error("The note content is missing.");
            expect(note.data.join("")).toBe(text);
        } finally {
            unsubscribe?.();
            await reader?.close().catch(() => undefined);
            await writer.close().catch(() => undefined);
            await Promise.all([source.destroy(), destination.destroy()]);
        }
    }, 30000);
});
