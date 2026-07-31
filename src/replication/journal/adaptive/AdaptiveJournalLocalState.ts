import type { SimpleStore } from "@lib/common/utils.ts";
import { compatGlobal } from "@lib/common/coreEnvFunctions.ts";

import { bytesEqual, bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalError,
    type AdaptiveJournalEncryption,
    type AdaptiveJournalKeySetV1,
    deriveWriterStreamIdV1,
} from "./AdaptiveJournalManifest.ts";
import type {
    AdaptiveJournalBindingStateV1,
    AdaptiveJournalBindingStoreV1,
    AdaptiveJournalPendingInitialisationV1,
} from "./AdaptiveJournalRepository.ts";
import type {
    AdaptiveJournalPendingCommitV1,
    AdaptiveJournalPendingWriterDescriptorV1,
    AdaptiveJournalWriterStateStoreV1,
    AdaptiveJournalWriterStateV1,
} from "./AdaptiveJournalWriter.ts";
import type { AdaptiveJournalWriterRegistrationStoreV1 } from "./AdaptiveJournalWriterRegistration.ts";
import type { AdaptiveJournalReceiveFrontierV1 } from "./AdaptiveJournalReceiver.ts";

type AdaptiveJournalStoredValueV1 =
    | AdaptiveJournalBindingStateV1
    | AdaptiveJournalWriterStateV1
    | Record<string, AdaptiveJournalReceiveFrontierV1>;

function clone<T>(value: T): T {
    return structuredClone(value);
}

export class AdaptiveJournalLocalBindingStoreV1 implements AdaptiveJournalBindingStoreV1 {
    private readonly key: string;

    constructor(
        private readonly store: SimpleStore<unknown>,
        storageIdentity: string,
        private readonly encryption: AdaptiveJournalEncryption
    ) {
        this.key = `adaptive-journal-v1:${storageIdentity}:binding`;
    }

    async load(): Promise<AdaptiveJournalBindingStateV1> {
        const stored = (await this.store.get(this.key)) as AdaptiveJournalBindingStateV1 | undefined;
        if (!stored) return { encryption: this.encryption };
        if (stored.encryption !== this.encryption) {
            throw new AdaptiveJournalError(
                "encryption-mode-mismatch",
                "Local Adaptive Journal binding encryption does not match the selected settings"
            );
        }
        return clone(stored);
    }

    async stageInitialisation(pendingInitialisation: AdaptiveJournalPendingInitialisationV1): Promise<void> {
        const state = await this.load();
        await this.store.set(this.key, {
            ...state,
            pendingInitialisation: clone(pendingInitialisation),
        } satisfies AdaptiveJournalStoredValueV1);
    }

    async acceptManifest(repositoryId: string): Promise<void> {
        const state = await this.load();
        await this.store.set(this.key, {
            encryption: state.encryption,
            repositoryId,
        } satisfies AdaptiveJournalStoredValueV1);
    }
}

export class AdaptiveJournalLocalWriterStateStoreV1
    implements AdaptiveJournalWriterStateStoreV1, AdaptiveJournalWriterRegistrationStoreV1
{
    private readonly key: string;

    constructor(
        private readonly store: SimpleStore<unknown>,
        storageIdentity: string
    ) {
        this.key = `adaptive-journal-v1:${storageIdentity}:writer`;
    }

    async initialise(keys: AdaptiveJournalKeySetV1, hostId: string): Promise<AdaptiveJournalWriterStateV1> {
        const existing = (await this.store.get(this.key)) as AdaptiveJournalWriterStateV1 | undefined;
        if (existing) {
            if (!bytesEqual(existing.repositoryId, keys.repositoryId)) {
                throw new AdaptiveJournalError(
                    "repository-id-mismatch",
                    "Local Writer state belongs to another Adaptive Journal repository"
                );
            }
            return clone(existing);
        }
        const writerEpochBytes = new Uint8Array(32);
        compatGlobal.crypto.getRandomValues(writerEpochBytes);
        const writerEpoch = bytesToBase64Url(writerEpochBytes);
        const state: AdaptiveJournalWriterStateV1 = {
            lastCommitDigest: null,
            lastCommittedSequence: 0n,
            lastLocalSequence: 0,
            repositoryId: keys.repositoryId.slice(),
            writerEpoch,
            writerRegistered: false,
            writerStreamId: await deriveWriterStreamIdV1(keys, hostId, writerEpoch),
        };
        await this.store.set(this.key, clone(state));
        return clone(state);
    }

    async load(): Promise<AdaptiveJournalWriterStateV1> {
        const state = (await this.store.get(this.key)) as AdaptiveJournalWriterStateV1 | undefined;
        if (!state) throw new Error("Adaptive Journal Writer state has not been initialised");
        return clone(state);
    }

    async stagePendingWriterDescriptor(pending: AdaptiveJournalPendingWriterDescriptorV1): Promise<void> {
        const state = await this.load();
        if (state.pendingWriterDescriptor) throw new Error("A Writer descriptor is already pending");
        await this.store.set(this.key, { ...state, pendingWriterDescriptor: clone(pending) });
    }

    async acceptPendingWriterDescriptor(expectedDigest: Uint8Array): Promise<void> {
        const state = await this.load();
        if (!state.pendingWriterDescriptor || !bytesEqual(state.pendingWriterDescriptor.descriptorDigest, expectedDigest)) {
            throw new AdaptiveJournalError(
                "pending-writer-descriptor-mismatch",
                "Pending Writer descriptor changed before acceptance"
            );
        }
        await this.store.set(this.key, {
            ...state,
            pendingWriterDescriptor: undefined,
            writerRegistered: true,
        });
    }

    async stagePendingCommit(pending: AdaptiveJournalPendingCommitV1): Promise<void> {
        const state = await this.load();
        if (state.pendingCommit) throw new Error("An Adaptive Journal Commit is already pending");
        await this.store.set(this.key, { ...state, pendingCommit: clone(pending) });
    }

    async acceptPendingCommit(expectedEnvelopeDigest: Uint8Array, commitFrameDigest: Uint8Array): Promise<void> {
        const state = await this.load();
        if (!state.pendingCommit || !bytesEqual(state.pendingCommit.envelopeDigest, expectedEnvelopeDigest)) {
            throw new AdaptiveJournalError("pending-commit-mismatch", "Pending Commit changed before acceptance");
        }
        await this.store.set(this.key, {
            ...state,
            lastCommitDigest: commitFrameDigest.slice(),
            lastCommittedSequence: state.pendingCommit.sequence,
            pendingCommit: undefined,
        });
    }

    async setLastLocalSequence(sequence: number | string): Promise<void> {
        const state = await this.load();
        await this.store.set(this.key, { ...state, lastLocalSequence: sequence });
    }
}

export class AdaptiveJournalLocalReceiveStateV1 {
    private readonly key: string;

    constructor(
        private readonly store: SimpleStore<unknown>,
        storageIdentity: string,
        repositoryId: Uint8Array
    ) {
        this.key = `adaptive-journal-v1:${storageIdentity}:receive:${bytesToBase64Url(repositoryId)}`;
    }

    private async load(): Promise<Record<string, AdaptiveJournalReceiveFrontierV1>> {
        return clone(
            ((await this.store.get(this.key)) as Record<string, AdaptiveJournalReceiveFrontierV1> | undefined) ?? {}
        );
    }

    async frontier(writerStreamId: Uint8Array): Promise<AdaptiveJournalReceiveFrontierV1> {
        const frontiers = await this.load();
        return clone(frontiers[bytesToBase64Url(writerStreamId)] ?? { commitDigest: null, sequence: 0n });
    }

    async accept(writerStreamId: Uint8Array, frontier: AdaptiveJournalReceiveFrontierV1): Promise<void> {
        const frontiers = await this.load();
        frontiers[bytesToBase64Url(writerStreamId)] = clone(frontier);
        await this.store.set(this.key, frontiers satisfies AdaptiveJournalStoredValueV1);
    }

    async clear(): Promise<void> {
        await this.store.delete(this.key);
    }
}

export async function clearAdaptiveJournalLocalStateV1(
    store: SimpleStore<unknown>,
    storageIdentity: string
): Promise<void> {
    const prefix = `adaptive-journal-v1:${storageIdentity}:`;
    const keys = await store.keys(prefix, `${prefix}\uffff`);
    await Promise.all(keys.filter((key) => key.startsWith(prefix)).map(async (key) => await store.delete(key)));
}
