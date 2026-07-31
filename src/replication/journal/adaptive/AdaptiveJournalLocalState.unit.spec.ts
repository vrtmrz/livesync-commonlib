import { describe, expect, it } from "vitest";

import type { SimpleStore } from "@lib/common/utils.ts";
import { createAdaptiveJournalManifestV1 } from "./AdaptiveJournalManifest.ts";
import {
    AdaptiveJournalLocalBindingStoreV1,
    AdaptiveJournalLocalReceiveStateV1,
    AdaptiveJournalLocalWriterStateStoreV1,
    clearAdaptiveJournalLocalStateV1,
} from "./AdaptiveJournalLocalState.ts";

function sequence(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => (start + index) & 0xff);
}

function memoryStore(): SimpleStore<unknown> {
    const values = new Map<string, unknown>();
    return {
        delete: async (key) => void values.delete(key),
        get: async (key) => structuredClone(values.get(key)),
        keys: async () => [...values.keys()],
        set: async (key, value) => void values.set(key, structuredClone(value)),
    } as unknown as SimpleStore<unknown>;
}

describe("Adaptive Journal local state", () => {
    it("persists one Writer epoch and rejects a substituted repository", async () => {
        const store = memoryStore();
        const first = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x10),
            securitySeed: sequence(0x80),
        });
        const second = await createAdaptiveJournalManifestV1({
            encryption: "unencrypted",
            repositoryId: sequence(0x11),
            securitySeed: sequence(0x81),
        });
        const writers = new AdaptiveJournalLocalWriterStateStoreV1(store, "remote-a");
        const initial = await writers.initialise(first.keys, "host-a");

        await expect(writers.initialise(first.keys, "host-a")).resolves.toEqual(initial);
        await expect(writers.initialise(second.keys, "host-a")).rejects.toMatchObject({
            code: "repository-id-mismatch",
        });
    });

    it("keeps manifest initialisation pending until the accepted repository is stored", async () => {
        const store = memoryStore();
        const binding = new AdaptiveJournalLocalBindingStoreV1(store, "remote-b", "unencrypted");
        const pending = { bytes: sequence(0x20), digest: sequence(0x40) };

        await binding.stageInitialisation(pending);
        await expect(binding.load()).resolves.toMatchObject({ pendingInitialisation: pending });
        await binding.acceptManifest("repository-id");
        await expect(binding.load()).resolves.toEqual({ encryption: "unencrypted", repositoryId: "repository-id" });
    });

    it("clears only the selected storage identity after a remote rebuild", async () => {
        const store = memoryStore();
        await store.set("adaptive-journal-v1:remote-a:binding", { value: "binding" });
        await store.set("adaptive-journal-v1:remote-a:writer", { value: "writer" });
        await store.set("adaptive-journal-v1:remote-b:binding", { value: "other remote" });
        await store.set("opaque-journal:checkpoint", { value: "opaque" });

        await clearAdaptiveJournalLocalStateV1(store, "remote-a");

        await expect(store.get("adaptive-journal-v1:remote-a:binding")).resolves.toBeUndefined();
        await expect(store.get("adaptive-journal-v1:remote-a:writer")).resolves.toBeUndefined();
        await expect(store.get("adaptive-journal-v1:remote-b:binding")).resolves.toEqual({ value: "other remote" });
        await expect(store.get("opaque-journal:checkpoint")).resolves.toEqual({ value: "opaque" });
    });

    it("resets receive frontiers without changing another local state namespace", async () => {
        const store = memoryStore();
        const receive = new AdaptiveJournalLocalReceiveStateV1(store, "remote-a", sequence(0x30));
        const writer = sequence(0x60);
        await receive.accept(writer, { commitDigest: sequence(0x90), sequence: 3n });
        await store.set("adaptive-journal-v1:remote-a:writer", { value: "writer state" });

        await receive.clear();

        await expect(receive.frontier(writer)).resolves.toEqual({ commitDigest: null, sequence: 0n });
        await expect(store.get("adaptive-journal-v1:remote-a:writer")).resolves.toEqual({
            value: "writer state",
        });
    });
});
