import { afterEach, describe, expect, it } from "vitest";
import { delay, promiseWithResolvers } from "octagonal-wheels/promises";

import { DOCID_SYNC_PARAMETERS, type FilePathWithPrefix } from "@lib/common/types.ts";
import { DirectFileManipulator } from "./DirectFileManipulatorV2.ts";

type Document = { _id: string; _rev?: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });
const missing = () => json({ error: "not_found" }, 404);

let servers = 0;

/** Mocks the CouchDB responses which these tests need from PouchDB's HTTP adapter. */
function createCouchDB() {
    // A new address for each server keeps per-database state out of later tests.
    const url = `https://couch-${++servers}.example.com`;
    const databases = new Map<string, Map<string, Document>>();
    let revision = 0;
    const database = (name: string) => databases.get(name) ?? databases.set(name, new Map()).get(name)!;
    const write = (documents: Map<string, Document>, doc: Document) => {
        // As in CouchDB, a local document accepts any revision, so the last write wins.
        if (!doc._id.startsWith("_local/") && documents.get(doc._id)?._rev !== doc._rev) {
            return { id: doc._id, error: "conflict" };
        }
        const rev = `${++revision}-mock`;
        documents.set(doc._id, { ...doc, _rev: rev });
        return { ok: true, id: doc._id, rev };
    };
    const respond = (method: string, pathname: string, body: any) => {
        const [name, ...rest] = pathname.slice(1).split("/").map(decodeURIComponent);
        const id = rest.join("/");
        if (!id) {
            if (method === "PUT") database(name);
            return databases.has(name) ? json({ db_name: name }) : missing();
        }
        const documents = database(name);
        if (id === "_bulk_docs")
            return json(
                body.docs.map((doc: Document) => write(documents, doc)),
                201
            );
        if (id === "_all_docs") {
            const rows = body.keys.map((key: string) => {
                const doc = documents.get(key);
                return doc ? { id: key, key, value: { rev: doc._rev }, doc } : { key, error: "not_found" };
            });
            return json({ rows });
        }
        if (method === "PUT") return json(write(documents, { ...body, _id: id }), 201);
        const doc = documents.get(id);
        return doc ? json(doc) : missing();
    };
    /** `latency` slows one client's local document responses to fix the order of concurrent requests. */
    const client =
        (latency: number): typeof fetch =>
        async (input, init) => {
            const request = new Request(input, init);
            const { pathname } = new URL(request.url);
            // The live changes feed stays open until the client cancels it.
            if (pathname.endsWith("/_changes")) {
                return new Promise((_, reject) => init?.signal?.addEventListener("abort", reject));
            }
            const body = await request.text();
            const response = respond(request.method, pathname, body && JSON.parse(body));
            if (pathname.includes("_local")) await delay(latency);
            return response;
        };
    return { url, database, client };
}

const manipulators: DirectFileManipulator[] = [];

async function connect(server: ReturnType<typeof createCouchDB>, database: string, latency = 0) {
    const options = { url: server.url, database, username: "user", password: "password" };
    const manipulator = new DirectFileManipulator(
        { ...options, passphrase: "passphrase", obfuscatePassphrase: undefined },
        { fetch: server.client(latency) }
    );
    manipulators.push(manipulator);
    await manipulator.ready.promise;
    return manipulator;
}

const put = (manipulator: DirectFileManipulator, path: string) =>
    manipulator.put(path, [path], { ctime: 1, mtime: 2, size: path.length });

const read = (manipulator: DirectFileManipulator, path: string) => manipulator.get(path as FilePathWithPrefix);

describe("DirectFileManipulator synchronisation parameters", () => {
    afterEach(async () => {
        await Promise.all(manipulators.splice(0).map((manipulator) => manipulator.close()));
    });

    it("uses the new database's salt after reconnecting", async () => {
        const server = createCouchDB();
        const manipulator = await connect(server, "first");
        await expect(put(manipulator, "first.md")).resolves.toBe(true);

        manipulator.options.database = "second";
        manipulator.ready = promiseWithResolvers<void>();
        await manipulator.init();
        await manipulator.ready.promise;
        await expect(put(manipulator, "second.md")).resolves.toBe(true);

        const reader = await connect(server, "second");
        await expect(read(reader, "second.md")).resolves.toMatchObject({ data: ["second.md"] });
    });

    it.each([
        ["missing", []],
        ["stored without a salt", [{ _id: DOCID_SYNC_PARAMETERS, type: "sync-parameters", protocolVersion: 2 }]],
    ])("shares one salt between concurrent first writes when the parameters are %s", async (_, stored) => {
        const server = createCouchDB();
        stored.forEach((doc) => server.database("vault").set(doc._id, doc));
        // The slower client would read the same starting state, then replace the faster client's salt.
        const faster = await connect(server, "vault", 5);
        const slower = await connect(server, "vault", 60);

        await expect(Promise.all([put(faster, "faster.md"), put(slower, "slower.md")])).resolves.toEqual([true, true]);

        const reader = await connect(server, "vault");
        await expect(read(reader, "faster.md")).resolves.toMatchObject({ data: ["faster.md"] });
        await expect(read(reader, "slower.md")).resolves.toMatchObject({ data: ["slower.md"] });
    });
});
