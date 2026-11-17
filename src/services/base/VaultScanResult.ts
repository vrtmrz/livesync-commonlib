import type { ReflectionOperationContext, ReflectionTarget } from "@lib/interfaces/FileHandler.ts";

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

/** Optional policy for an ordinary scan; omitted options retain strict content checks. */
export interface VaultScanOptions {
    /** False permits unchanged tracked files to be skipped using storage and revision metadata. */
    strictContentCheck?: boolean;
    /** Existing target scope borrowed by a retained scan retry, including its write checkpoint. */
    reflectionOperation?: ReflectionOperationContext;
    /** Await the owning host's response to an unsuccessful database-to-Vault content read. */
    onReflectionFailed?: (target: ReflectionTarget, error: unknown) => void | Promise<void>;
}

export type VaultScanResult = (typeof VaultScanResults)[keyof typeof VaultScanResults];
