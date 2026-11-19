import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedReplicationStatics } from "@lib/common/models/shared.definition.ts";
import { DEFAULT_REPLICATION_STATICS } from "@lib/common/models/shared.definition.ts";
import { ReplicationStaticsOwner, type ReplicationStaticsSource } from "./ReplicationStaticsOwner.ts";

describe("ReplicationStaticsOwner", () => {
    afterEach(() => vi.restoreAllMocks());

    it("notifies removable subscribers without exposing a writable snapshot", () => {
        const owner = new ReplicationStaticsOwner();
        const onChanged = vi.fn<ReplicationStaticsSource["onChanged"]>();
        vi.spyOn(Date, "now").mockReturnValue(42);
        expect(owner.source.value.statsUpdatedAt).toBeNull();
        expect(Object.isFrozen(DEFAULT_REPLICATION_STATICS)).toBe(true);
        expect(Object.isFrozen(owner.source.value)).toBe(true);
        owner.source.onChanged(onChanged);

        owner.source.value = { ...DEFAULT_REPLICATION_STATICS, statsUpdatedAt: 7 };

        expect(onChanged).toHaveBeenCalledOnce();
        const published: PublishedReplicationStatics = onChanged.mock.calls[0]![0].value;
        expect(published.statsUpdatedAt).toBe(42);
        expect(Object.isFrozen(published)).toBe(true);
        expect(Reflect.set(published, "statsUpdatedAt", 100)).toBe(false);
        expect(owner.source.value.statsUpdatedAt).toBe(42);
        expect(owner.source.value.statsUpdatedAt).toBe(42);

        owner.source.offChanged(onChanged);
        owner.source.value = { ...DEFAULT_REPLICATION_STATICS, sent: 1 };
        expect(onChanged).toHaveBeenCalledOnce();
        owner.reset();
        expect(owner.source.value.statsUpdatedAt).toBeNull();
        expect(Object.isFrozen(owner.source.value)).toBe(true);
    });
});
