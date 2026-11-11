/** Return the explicit opt-in; absent and non-boolean values remain disabled. */
export function normaliseAcceptUnencryptedContent(value: unknown): boolean {
    return value === true;
}
