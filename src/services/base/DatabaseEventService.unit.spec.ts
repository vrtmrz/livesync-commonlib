import { describe, expect, it, vi } from "vitest";
import { createServiceContext } from "./ServiceBase";
import { InjectableDatabaseEventService } from "../implements/injectable/InjectableDatabaseEventService";
import { VaultScanResults } from "./VaultScanResult";

describe("DatabaseEventService", () => {
    it("preserves a partial initialisation result after later handlers succeed", async () => {
        const service = new InjectableDatabaseEventService(createServiceContext());
        const laterHandler = vi.fn(async () => VaultScanResults.COMPLETED);
        service.initialiseDatabase.addHandler(async () => VaultScanResults.COMPLETED_WITH_FILE_FAILURES);
        service.initialiseDatabase.addHandler(laterHandler);

        await expect(service.initialiseDatabase()).resolves.toBe(VaultScanResults.COMPLETED_WITH_FILE_FAILURES);
        expect(laterHandler).toHaveBeenCalledOnce();
    });

    it("settles every close handler even when an earlier handler fails", async () => {
        const service = new InjectableDatabaseEventService(createServiceContext());
        const calls: string[] = [];
        service.onCloseDatabase.addHandler(async () => {
            calls.push("first");
            return false;
        });
        service.onCloseDatabase.addHandler(async () => {
            calls.push("second");
            return true;
        });

        await expect(service.onCloseDatabase(undefined!)).resolves.toBe(false);

        expect(calls).toEqual(["first", "second"]);
    });

    it("settles later close handlers after an earlier exception", async () => {
        const service = new InjectableDatabaseEventService(createServiceContext());
        const calls: string[] = [];
        service.onCloseDatabase.addHandler(async () => {
            calls.push("first");
            throw new Error("cleanup failed");
        });
        service.onCloseDatabase.addHandler(async () => {
            calls.push("second");
            return true;
        });

        await expect(service.onCloseDatabase(undefined!)).resolves.toBe(false);

        expect(calls).toEqual(["first", "second"]);
    });
});
