import { describe, expect, it, vi } from "vitest";

import { bytesToBase64Url } from "./AdaptiveJournalBinary.ts";
import {
    AdaptiveJournalError,
    createAdaptiveJournalManifestV1,
    type AdaptiveJournalManifestCandidateV1,
} from "./AdaptiveJournalManifest.ts";
import {
    openAdaptiveJournalRepositoryV1,
    type AdaptiveJournalBindingStateV1,
    type AdaptiveJournalBindingStoreV1,
    type AdaptiveJournalManifestRemoteV1,
    type ImmutableCreate,
    type RemoteRead,
} from "./AdaptiveJournalRepository.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

async function candidate(start: number): Promise<AdaptiveJournalManifestCandidateV1> {
    return await createAdaptiveJournalManifestV1({
        encryption: "encrypted",
        passphrase: "repository passphrase",
        repositoryId: sequence(start),
        securitySeed: sequence(start + 0x40),
    });
}

class MemoryBindingStore implements AdaptiveJournalBindingStoreV1 {
    readonly accepted: string[] = [];
    readonly staged: string[] = [];

    constructor(public state: AdaptiveJournalBindingStateV1) {}

    async load(): Promise<AdaptiveJournalBindingStateV1> {
        return {
            ...this.state,
            pendingInitialisation: this.state.pendingInitialisation
                ? {
                      bytes: this.state.pendingInitialisation.bytes.slice(),
                      digest: this.state.pendingInitialisation.digest.slice(),
                  }
                : undefined,
        };
    }

    async stageInitialisation(pending: { bytes: Uint8Array; digest: Uint8Array }): Promise<void> {
        this.staged.push(bytesToBase64Url(pending.digest));
        this.state = {
            ...this.state,
            pendingInitialisation: { bytes: pending.bytes.slice(), digest: pending.digest.slice() },
        };
    }

    async acceptManifest(repositoryId: string): Promise<void> {
        this.accepted.push(repositoryId);
        this.state = { encryption: this.state.encryption, repositoryId };
    }
}

class MemoryManifestRemote implements AdaptiveJournalManifestRemoteV1 {
    readonly createCalls: Uint8Array[] = [];
    readonly capabilityCalls: readonly string[][] = [];
    capabilityResult: Awaited<ReturnType<AdaptiveJournalManifestRemoteV1["verifyCapabilities"]>> = {
        status: "verified",
    };
    createResult?: ImmutableCreate;
    readResult?: RemoteRead<Uint8Array>;
    stored?: Uint8Array;

    async readManifest(): Promise<RemoteRead<Uint8Array>> {
        if (this.readResult) return this.readResult;
        return this.stored ? { status: "found", value: this.stored.slice() } : { status: "missing" };
    }

    async createManifest(bytes: Uint8Array): Promise<ImmutableCreate> {
        this.createCalls.push(bytes.slice());
        if (this.createResult) return this.createResult;
        if (this.stored) return { status: "already-exists" };
        this.stored = bytes.slice();
        return { status: "created" };
    }

    async verifyCapabilities(required: readonly string[]) {
        (this.capabilityCalls as string[][]).push([...required]);
        return this.capabilityResult;
    }
}

describe("Adaptive Journal repository initialisation", () => {
    it("persists an exact pending candidate before conditional creation and pins the read-back winner", async () => {
        const expectedCandidate = await candidate(0x10);
        const binding = new MemoryBindingStore({ encryption: "encrypted" });
        const remote = new MemoryManifestRemote();

        const opened = await openAdaptiveJournalRepositoryV1({
            additionalRequiredCapabilities: ["byte-range", "conditional-create"],
            binding,
            candidateFactory: vi.fn(async () => expectedCandidate),
            intent: "create-new",
            passphrase: "repository passphrase",
            remote,
        });

        expect(opened.disposition).toBe("created");
        expect(remote.createCalls).toEqual([expectedCandidate.bytes]);
        expect(binding.staged).toEqual([bytesToBase64Url(expectedCandidate.digest)]);
        expect(binding.accepted).toEqual([expectedCandidate.manifest.repositoryId]);
        expect(binding.state.pendingInitialisation).toBeUndefined();
        expect(binding.state.repositoryId).toBe(expectedCandidate.manifest.repositoryId);
        expect(remote.capabilityCalls).toEqual([
            [
                "binary-fidelity",
                "complete-listing",
                "conditional-create",
                "delete-visibility",
                "read-after-write",
                "byte-range",
            ],
        ]);
    });

    it("never creates or generates values when attach-existing observes an explicitly missing manifest", async () => {
        const binding = new MemoryBindingStore({ encryption: "encrypted" });
        const remote = new MemoryManifestRemote();
        const candidateFactory = vi.fn(async () => await candidate(0x20));

        await expect(
            openAdaptiveJournalRepositoryV1({
                binding,
                candidateFactory,
                intent: "attach-existing",
                passphrase: "repository passphrase",
                remote,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "repository-missing" });
        expect(candidateFactory).not.toHaveBeenCalled();
        expect(remote.createCalls).toHaveLength(0);
        expect(remote.capabilityCalls).toHaveLength(0);
    });

    it("adopts a valid concurrent winner rather than merging or overwriting manifest fields", async () => {
        const localCandidate = await candidate(0x30);
        const winner = await candidate(0x31);
        const binding = new MemoryBindingStore({ encryption: "encrypted" });
        const remote = new MemoryManifestRemote();
        remote.createResult = { status: "already-exists" };
        const originalCreate = remote.createManifest.bind(remote);
        remote.createManifest = vi.fn(async (bytes: Uint8Array) => {
            const result = await originalCreate(bytes);
            remote.stored = winner.bytes.slice();
            return result;
        });

        const opened = await openAdaptiveJournalRepositoryV1({
            binding,
            candidateFactory: vi.fn(async () => localCandidate),
            intent: "create-new",
            passphrase: "repository passphrase",
            remote,
        });

        expect(opened.disposition).toBe("attached-concurrent");
        expect(opened.manifest.repositoryId).toBe(winner.manifest.repositoryId);
        expect(binding.state.repositoryId).toBe(winner.manifest.repositoryId);
        expect(remote.createCalls).toEqual([localCandidate.bytes]);
    });

    it("resolves a persisted pending candidate before allocating another identity", async () => {
        const pending = await candidate(0x40);
        const binding = new MemoryBindingStore({
            encryption: "encrypted",
            pendingInitialisation: { bytes: pending.bytes, digest: pending.digest },
        });
        const remote = new MemoryManifestRemote();
        remote.stored = pending.bytes.slice();
        const candidateFactory = vi.fn(async () => await candidate(0x41));

        const opened = await openAdaptiveJournalRepositoryV1({
            binding,
            candidateFactory,
            intent: "create-new",
            passphrase: "repository passphrase",
            remote,
        });

        expect(opened.disposition).toBe("recovered");
        expect(candidateFactory).not.toHaveBeenCalled();
        expect(remote.createCalls).toHaveLength(0);
        expect(binding.state.repositoryId).toBe(pending.manifest.repositoryId);
    });

    it("does not interpret authentication or capability failures as a missing repository", async () => {
        const binding = new MemoryBindingStore({ encryption: "encrypted" });
        const failedRemote = new MemoryManifestRemote();
        failedRemote.readResult = {
            status: "failed",
            failure: { category: "authentication", retry: "never" },
        };
        const candidateFactory = vi.fn(async () => await candidate(0x50));
        await expect(
            openAdaptiveJournalRepositoryV1({
                binding,
                candidateFactory,
                intent: "create-new",
                passphrase: "repository passphrase",
                remote: failedRemote,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "remote-operation-failed" });
        expect(candidateFactory).not.toHaveBeenCalled();

        const unsafeRemote = new MemoryManifestRemote();
        unsafeRemote.capabilityResult = { status: "unsupported", missing: ["conditional-create"] };
        await expect(
            openAdaptiveJournalRepositoryV1({
                binding: new MemoryBindingStore({ encryption: "encrypted" }),
                candidateFactory,
                intent: "create-new",
                passphrase: "repository passphrase",
                remote: unsafeRemote,
            })
        ).rejects.toMatchObject<Partial<AdaptiveJournalError>>({ code: "required-capability-missing" });
        expect(unsafeRemote.createCalls).toHaveLength(0);
    });
});
