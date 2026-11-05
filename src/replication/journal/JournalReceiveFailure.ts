import type { JournalReceiveFailureStage } from "./JournalSyncTypes.ts";

export class JournalReceiveFailure extends Error {
    constructor(
        readonly stage: JournalReceiveFailureStage,
        readonly key?: string
    ) {
        super("Journal receive failed at " + stage);
    }
}

export function isJournalReceiveFailure(error: unknown): error is JournalReceiveFailure {
    return error instanceof JournalReceiveFailure;
}
