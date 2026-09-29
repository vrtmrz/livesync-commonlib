import { describe, expect, it } from "vitest";
import { VERSIONING_DOCID, type EntryDoc, type FilePathWithPrefix } from "@lib/common/types.ts";
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
