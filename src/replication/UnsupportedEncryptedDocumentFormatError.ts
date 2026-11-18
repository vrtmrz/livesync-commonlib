const UNSUPPORTED_FORMAT_ERROR_NAME = "UnsupportedEncryptedDocumentFormatError";

/** Raised when the reader has no decoding route for a document marked as encrypted. */
export class UnsupportedEncryptedDocumentFormatError extends Error {
    override readonly name = UNSUPPORTED_FORMAT_ERROR_NAME;

    constructor(options?: { cause?: unknown }) {
        super("Encrypted file content uses a representation which this E2EE reader cannot decrypt.", options);
    }

    /**
     * Finds the rejection in a cause chain. PouchDB copies the error's own
     * properties into a different error type. Recover the class from its name
     * and keep the reported exception as the cause for diagnostics.
     */
    static findIn(error: unknown): UnsupportedEncryptedDocumentFormatError | undefined {
        const seen = new Set<object>();
        let current = error;
        while (typeof current === "object" && current !== null && !seen.has(current)) {
            if (current instanceof UnsupportedEncryptedDocumentFormatError) return current;
            if (current instanceof Error && current.name === UNSUPPORTED_FORMAT_ERROR_NAME) {
                return new UnsupportedEncryptedDocumentFormatError({ cause: current });
            }
            seen.add(current);
            current = "cause" in current ? current.cause : undefined;
        }
        return undefined;
    }
}
