const UNSUPPORTED_FORMAT_ERROR_NAME = "UnsupportedEncryptedDocumentFormatError";

/** Encrypted file content for which the configured reader has no supported decode route. */
export class UnsupportedEncryptedDocumentFormatError extends Error {
    override readonly name = UNSUPPORTED_FORMAT_ERROR_NAME;

    constructor() {
        super("Encrypted file content uses a representation which this E2EE reader cannot decrypt.");
    }

    static findIn(error: unknown): UnsupportedEncryptedDocumentFormatError | undefined {
        const seen = new Set<object>();
        let current = error;
        while (typeof current === "object" && current !== null && !seen.has(current)) {
            if (current instanceof UnsupportedEncryptedDocumentFormatError) return current;
            // PouchDB recreates replication errors with their own properties.
            if (current instanceof Error && current.name === UNSUPPORTED_FORMAT_ERROR_NAME) {
                return new UnsupportedEncryptedDocumentFormatError();
            }
            seen.add(current);
            current = "cause" in current ? current.cause : undefined;
        }
        return undefined;
    }
}
