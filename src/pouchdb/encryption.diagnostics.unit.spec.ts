import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    E2EEAlgorithms,
    type DocumentID,
    type EntryDoc,
    type FilePathWithPrefix,
    type PlainEntry,
} from "@lib/common/types";
import { defaultLogger, setGlobalLogFunction, type LoggerFunction } from "@lib/common/logger";
import { path2id_base } from "@lib/string_and_binary/path";
import { getConfiguredFunctionsForEncryption } from "./encryption";

const workerErrors = vi.hoisted(() => ({
    v1: null as unknown,
    hkdf: null as unknown,
}));

vi.mock("#worker", async (importOriginal) => {
    const workers = await importOriginal<typeof import("#worker")>();
    return {
        ...workers,
        decryptWorker: (...args: Parameters<typeof workers.decryptWorker>) =>
            workerErrors.v1 === null ? workers.decryptWorker(...args) : Promise.reject(workerErrors.v1),
        decryptHKDFWorker: (...args: Parameters<typeof workers.decryptHKDFWorker>) =>
            workerErrors.hkdf === null ? workers.decryptHKDFWorker(...args) : Promise.reject(workerErrors.hkdf),
    };
});

type ConfigureWithOperationLogger = (
    passphrase: string,
    useDynamicIterationCount: boolean,
    migrationDecrypt: boolean,
    getPBKDF2Salt: () => Promise<Uint8Array<ArrayBuffer>>,
    algorithm: (typeof E2EEAlgorithms)[keyof typeof E2EEAlgorithms],
    encryptInternalMetadata?: boolean,
    log?: LoggerFunction
) => ReturnType<typeof getConfiguredFunctionsForEncryption>;

const configureWithOperationLogger = getConfiguredFunctionsForEncryption as unknown as ConfigureWithOperationLogger;
const globalLogEntries: unknown[] = [];

function logText() {
    return globalLogEntries
        .map((entry) => (entry instanceof Error ? `${entry.name}:${entry.message}` : String(entry)))
        .join("\n");
}

function makeChunk(data: string): EntryDoc {
    return {
        _id: "h:+private-vault-chunk-id" as DocumentID,
        _rev: "8-private-vault-revision",
        type: "chunk",
        data,
        e_: true,
        path: "Private Folder/private-note.md" as FilePathWithPrefix,
    } as unknown as EntryDoc;
}

beforeEach(() => {
    globalLogEntries.length = 0;
    setGlobalLogFunction((message) => globalLogEntries.push(message));
});

afterEach(() => {
    workerErrors.v1 = null;
    workerErrors.hkdf = null;
    setGlobalLogFunction(defaultLogger);
});

describe("operation-owned decryption logging", () => {
    it("preserves successful V2 round trips when an operation logger is supplied", async () => {
        const passphrase = "diagnostics-success-secret";
        const salt = new Uint8Array(16);
        const path = "Folder/Private note.md" as FilePathWithPrefix;
        const document: PlainEntry = {
            _id: `f:${"a".repeat(64)}` as DocumentID,
            path,
            type: "plain",
            ctime: 10,
            mtime: 20,
            size: 30,
            children: [],
            eden: {},
        };
        const { incoming, outgoing } = configureWithOperationLogger(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2,
            false,
            () => {}
        );

        const encrypted = await incoming(document);
        await expect(outgoing(encrypted)).resolves.toMatchObject(document);
    });

    it.each([E2EEAlgorithms.V1, E2EEAlgorithms.ForceV1])(
        "silences %s outgoing failures while default logging remains intact",
        async (algorithm) => {
            const passphrase = "diagnostics-v1-secret";
            const salt = new Uint8Array(16);
            const revision = "8-private-vault-revision";
            const legacyWriter = configureWithOperationLogger(passphrase, false, false, async () => salt, algorithm);
            const plainChunk = makeChunk("private payload") as unknown as Record<string, unknown>;
            delete plainChunk.e_;
            const encrypted = await legacyWriter.incoming(plainChunk as unknown as EntryDoc);
            const privateError = new Error("private-path-name.md: private decryption failure text");
            workerErrors.v1 = privateError;

            const silentReader = configureWithOperationLogger(
                passphrase,
                false,
                false,
                async () => salt,
                algorithm,
                false,
                () => {}
            );
            await expect(silentReader.outgoing(encrypted)).rejects.toBeDefined();
            expect(globalLogEntries).toEqual([]);

            const defaultReader = getConfiguredFunctionsForEncryption(
                passphrase,
                false,
                false,
                async () => salt,
                algorithm
            );
            await expect(defaultReader.outgoing(encrypted)).rejects.toBeDefined();
            expect(logText()).toContain("private decryption failure text");
            if (algorithm === E2EEAlgorithms.ForceV1) {
                expect(logText()).toContain("h:+private-vault-chunk-id");
                expect(logText()).toContain(revision.substring(0, 10));
            }
        }
    );

    it("silences HKDF fallback and embedded Metadata failures without hiding errors", async () => {
        const passphrase = "diagnostics-hkdf-secret";
        const salt = new Uint8Array(16);
        const legacyWriter = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V1
        );
        const plainChunk = makeChunk("private legacy payload") as unknown as Record<string, unknown>;
        delete plainChunk.e_;
        const legacyData = await legacyWriter.incoming(plainChunk as unknown as EntryDoc);
        const privateError = new Error("private-path-name.md: private HKDF decryption failure text");
        workerErrors.v1 = privateError;

        const silentFallback = configureWithOperationLogger(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2,
            false,
            () => {}
        );
        await expect(silentFallback.outgoing(legacyData)).rejects.toThrow("Failed to decrypt the data with V1 method");
        expect(globalLogEntries).toEqual([]);

        const defaultFallback = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        await expect(defaultFallback.outgoing(legacyData)).rejects.toThrow("Failed to decrypt the data with V1 method");
        expect(logText()).toContain("private HKDF decryption failure text");

        globalLogEntries.length = 0;
        const path = "i:.obsidian/private-metadata.md" as FilePathWithPrefix;
        const internalMetadata: PlainEntry = {
            _id: await path2id_base(path, passphrase, false),
            path,
            type: "plain",
            ctime: 10,
            mtime: 20,
            size: 30,
            children: [],
            eden: {},
        };
        const metadataWriter = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2,
            true
        );
        const encryptedMetadata = await metadataWriter.incoming(internalMetadata);
        workerErrors.v1 = null;
        workerErrors.hkdf = privateError;
        const silentMetadataReader = configureWithOperationLogger(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2,
            false,
            () => {}
        );
        await expect(silentMetadataReader.outgoing(encryptedMetadata)).rejects.toBe(privateError);
        expect(globalLogEntries).toEqual([]);

        const defaultMetadataReader = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            async () => salt,
            E2EEAlgorithms.V2
        );
        await expect(defaultMetadataReader.outgoing(encryptedMetadata)).rejects.toBe(privateError);
        expect(logText()).toContain("private HKDF decryption failure text");
    });

    it("silences missing-salt errors and keeps default error logging", async () => {
        const passphrase = "diagnostics-missing-salt-secret";
        const salt = new Uint8Array(16);
        const encryptedData = "%=private-invalid-hkdf-data";
        const missingSaltError = new Error("private-path-name.md: private salt lookup failure");
        const getMissingSalt = async () => {
            throw missingSaltError;
        };
        const silentReader = configureWithOperationLogger(
            passphrase,
            false,
            false,
            getMissingSalt,
            E2EEAlgorithms.V2,
            false,
            () => {}
        );

        await expect(silentReader.outgoing(makeChunk(encryptedData))).rejects.toBe(missingSaltError);
        expect(globalLogEntries).toEqual([]);

        const defaultReader = getConfiguredFunctionsForEncryption(
            passphrase,
            false,
            false,
            getMissingSalt,
            E2EEAlgorithms.V2
        );
        await expect(defaultReader.outgoing(makeChunk(encryptedData))).rejects.toBe(missingSaltError);
        expect(logText()).toContain("private salt lookup failure");
    });
});
