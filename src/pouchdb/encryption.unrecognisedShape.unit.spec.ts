import { UnsupportedEncryptedDocumentFormatError } from "@lib/replication/UnsupportedEncryptedDocumentFormatError.ts";
import { describe, expect, it, vi } from "vitest";
import { E2EEAlgorithms, type DocumentID, type EntryDoc, type EntryLeaf } from "@lib/common/types";
import { decryptHKDF, encryptHKDF, getConfiguredFunctionsForEncryption } from "./encryption";
import { UnencryptedContentRejectedError } from "@lib/replication/UnencryptedContentRejectedError";

const passphrase = "issue-1365-synthetic-passphrase";
const salt = new Uint8Array(16).fill(7);
const notePath = "notes/synthetic-note.md";
const noteContent = "# Synthetic note\nEncrypted content: café.\n";
const reportedId = "h:0123456789abcdef0123456789abcdef" as DocumentID;

// The reported writer is unknown. This fixture reproduces its shape, not its origin.
async function createReportedShape() {
    return {
        _id: reportedId,
        type: "plain" as const,
        e_: true as const,
        path: await encryptHKDF(notePath, passphrase, salt),
        data: await encryptHKDF(noteContent, passphrase, salt),
        ctime: 1_700_000_000_000,
        mtime: 1_700_000_000_000,
        size: new TextEncoder().encode(noteContent).byteLength,
        eden: {},
    };
}

function createReader(acceptUnencryptedContent = false, getSalt = async () => salt) {
    return getConfiguredFunctionsForEncryption(
        passphrase,
        false,
        false,
        getSalt,
        E2EEAlgorithms.V2,
        false,
        undefined,
        acceptUnencryptedContent
    );
}

describe("Issue #1365 encrypted document shape", () => {
    it("contains authenticated ciphertext for both the note and its path", async () => {
        const document = await createReportedShape();
        expect(document.path).toMatch(/^%=/);
        expect(document.data).toMatch(/^%=/);
        await expect(decryptHKDF(document.path, passphrase, salt)).resolves.toBe(notePath);
        await expect(decryptHKDF(document.data, passphrase, salt)).resolves.toBe(noteContent);
        await expect(decryptHKDF(document.data, "another-passphrase", salt)).rejects.toThrow();
    });

    it("reads a supported encrypted Chunk written by the current encryption writer", async () => {
        const reader = createReader();
        const chunk: EntryLeaf = {
            _id: "h:+0123456789abcdef0123456789abcdef" as DocumentID,
            type: "leaf",
            data: noteContent,
        };
        const encrypted = await reader.incoming(chunk);
        expect(encrypted).toMatchObject({ _id: chunk._id, type: "leaf", e_: true });
        expect(encrypted).toMatchObject({ data: expect.stringMatching(/^%=/) });
        const decoded = await reader.outgoing(encrypted as EntryDoc);
        expect(decoded).toMatchObject(chunk);
        expect(decoded).not.toHaveProperty("e_");
    });

    it.each([false, true])(
        "rejects the reported shape before key access, preserving its ciphertext (accept plaintext: %s)",
        async (acceptUnencryptedContent) => {
            const document = await createReportedShape();
            const original = structuredClone(document);
            const getSalt = vi.fn(async () => salt);
            const reader = createReader(acceptUnencryptedContent, getSalt);
            const result = reader.outgoing(document as unknown as EntryDoc);

            await expect(result).rejects.toBeInstanceOf(UnsupportedEncryptedDocumentFormatError);
            await expect(result).rejects.not.toBeInstanceOf(UnencryptedContentRejectedError);
            expect(getSalt).not.toHaveBeenCalled();
            expect(document).toEqual(original);
        }
    );

    it("also refuses the same ciphertext under a leaf type when the ID has no encryption marker", async () => {
        const document = { ...(await createReportedShape()), type: "leaf" as const };
        await expect(createReader().outgoing(document as unknown as EntryDoc)).rejects.toThrow();
    });

    it("selects body decryption by ID without treating the encrypted path as Metadata", async () => {
        const document = { ...(await createReportedShape()), _id: `h:+${reportedId.slice(2)}` as DocumentID };
        const decoded = await createReader().outgoing(document as unknown as EntryDoc);
        expect(decoded).toMatchObject({ _id: document._id, data: noteContent, path: document.path });
        expect(decoded).not.toHaveProperty("e_");
        // Decoding this body does not establish that the record is valid file Metadata.
        expect(document.path).not.toBe(notePath);
    });

    it("allows an explicit tombstone without attempting to decrypt its former body", async () => {
        const document = { ...(await createReportedShape()), _deleted: true };
        await expect(createReader().outgoing(document as unknown as EntryDoc)).resolves.toEqual(document);
    });
});
