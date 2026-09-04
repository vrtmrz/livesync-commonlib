/**
 * Outcome of scanning the Vault against the local database.
 *
 * Boolean values preserve the existing success and failure contract. The
 * additional value lets an ordinary start-up remain ready while reporting
 * that one or more individual files still require attention.
 */
export const VaultScanResults = {
    FAILED: false,
    COMPLETED: true,
    COMPLETED_WITH_FILE_FAILURES: "completed-with-file-failures",
} as const;

export type VaultScanResult = (typeof VaultScanResults)[keyof typeof VaultScanResults];
