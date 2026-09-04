import { describe, expect, it, vi } from "vitest";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE } from "@lib/common/types.ts";
import { CENTRAL_REMOTE_REPLICATION_READINESS, PEER_REPLICATION_READINESS } from "@lib/replication";
import { MARK_LOG_NETWORK_ERROR } from "@lib/services/lib/logUtils.ts";
import {
    createReplicationReadinessEvaluator,
    type ReplicationReadinessDependencies,
} from "./ReplicationService.readiness.ts";

function createHarness() {
    const calls: string[] = [];
    const dependencies: ReplicationReadinessDependencies = {
        gates: {
            isApplicationReady: vi.fn(() => {
                calls.push("application-ready");
                return true;
            }),
            runPolicyChecks: vi.fn(async () => {
                calls.push("policy-checks");
                return true;
            }),
            currentSettings: vi.fn(() => {
                calls.push("settings");
                return { versionUpFlash: "" };
            }),
            isCleanupRunning: vi.fn(() => {
                calls.push("cleanup");
                return false;
            }),
            isOnline: vi.fn(() => {
                calls.push("online");
                return true;
            }),
        },
        preparation: {
            commitPendingFileEvents: vi.fn(async () => {
                calls.push("pending-file-events");
                return true;
            }),
            prepareCentralRemote: vi.fn(async () => {
                calls.push("central-remote");
                return true;
            }),
            runBeforeReplicate: vi.fn(async () => {
                calls.push("before-replicate");
                return true;
            }),
        },
        diagnostics: {
            getUnresolvedMessages: vi.fn(async () => []),
            translate: vi.fn((key) => key),
            log: vi.fn(),
            showError: vi.fn(),
            clearErrors: vi.fn(() => {
                calls.push("clear-errors");
            }),
        },
    };
    return { calls, dependencies, evaluate: createReplicationReadinessEvaluator(dependencies) };
}

describe("createReplicationReadinessEvaluator", () => {
    it("runs central preparation between common policy gates and general preparation", async () => {
        const { calls, dependencies, evaluate } = createHarness();

        await expect(
            evaluate({ showMessage: true, requirements: CENTRAL_REMOTE_REPLICATION_READINESS })
        ).resolves.toEqual({ ready: true, purpose: "replication" });

        expect(calls).toEqual([
            "application-ready",
            "policy-checks",
            "settings",
            "cleanup",
            "pending-file-events",
            "online",
            "central-remote",
            "before-replicate",
            "clear-errors",
        ]);
        expect(dependencies.preparation.prepareCentralRemote).toHaveBeenCalledWith(true);
        expect(dependencies.preparation.runBeforeReplicate).toHaveBeenCalledWith(true);
    });

    it("skips central preparation for a peer provider without skipping common gates", async () => {
        const { calls, dependencies, evaluate } = createHarness();

        await expect(evaluate({ requirements: PEER_REPLICATION_READINESS })).resolves.toEqual({
            ready: true,
            purpose: "replication",
        });

        expect(dependencies.preparation.prepareCentralRemote).not.toHaveBeenCalled();
        expect(calls).toContain("pending-file-events");
        expect(calls).toContain("before-replicate");
    });

    it("stops before remote preparation when an earlier policy gate fails", async () => {
        const { dependencies, evaluate } = createHarness();
        vi.mocked(dependencies.gates.runPolicyChecks).mockResolvedValue(false);

        await expect(evaluate()).resolves.toEqual({
            ready: false,
            purpose: "replication",
            rejectedCondition: "replication-policy-approved",
        });

        expect(dependencies.gates.currentSettings).not.toHaveBeenCalled();
        expect(dependencies.preparation.commitPendingFileEvents).not.toHaveBeenCalled();
        expect(dependencies.preparation.prepareCentralRemote).not.toHaveBeenCalled();
        expect(dependencies.preparation.runBeforeReplicate).not.toHaveBeenCalled();
    });

    it("reports a descriptive diagnostic when the application is not ready", async () => {
        const { dependencies, evaluate } = createHarness();
        vi.mocked(dependencies.gates.isApplicationReady).mockReturnValue(false);

        await expect(evaluate()).resolves.toEqual({
            ready: false,
            purpose: "replication",
            rejectedCondition: "application-ready",
        });

        expect(dependencies.diagnostics.translate).not.toHaveBeenCalled();
        expect(dependencies.diagnostics.log).toHaveBeenCalledWith(
            "Replication is not ready because application initialisation has not completed."
        );
        expect(dependencies.diagnostics.log).not.toHaveBeenCalledWith("Not ready");
    });

    it("does not run general preparation after required central preparation fails", async () => {
        const { dependencies, evaluate } = createHarness();
        vi.mocked(dependencies.preparation.prepareCentralRemote).mockResolvedValue(false);

        await expect(evaluate()).resolves.toEqual({
            ready: false,
            purpose: "replication",
            rejectedCondition: "central-remote-prepared",
        });

        expect(dependencies.preparation.runBeforeReplicate).not.toHaveBeenCalled();
        expect(dependencies.diagnostics.showError).toHaveBeenCalledWith(
            "Replicator.Message.SomeModuleFailed",
            LOG_LEVEL_NOTICE
        );
    });

    it("keeps a generic preparation failure informational when a network diagnostic already exists", async () => {
        const { dependencies, evaluate } = createHarness();
        vi.mocked(dependencies.preparation.runBeforeReplicate).mockResolvedValue(false);
        vi.mocked(dependencies.diagnostics.getUnresolvedMessages).mockResolvedValue([
            [`${MARK_LOG_NETWORK_ERROR}connection failed`],
        ]);

        await expect(evaluate()).resolves.toEqual({
            ready: false,
            purpose: "replication",
            rejectedCondition: "general-replication-prepared",
        });

        expect(dependencies.diagnostics.log).toHaveBeenCalledWith(
            "Replicator.Message.SomeModuleFailed",
            LOG_LEVEL_INFO
        );
        expect(dependencies.diagnostics.showError).not.toHaveBeenCalledWith(
            "Replicator.Message.SomeModuleFailed",
            LOG_LEVEL_NOTICE
        );
    });

    it("reports pending-file and offline failures without starting provider preparation", async () => {
        const pending = createHarness();
        vi.mocked(pending.dependencies.preparation.commitPendingFileEvents).mockResolvedValue(false);
        await expect(pending.evaluate()).resolves.toEqual({
            ready: false,
            purpose: "replication",
            rejectedCondition: "pending-file-events-committed",
        });
        expect(pending.dependencies.diagnostics.showError).toHaveBeenCalledWith(
            "Replicator.Message.Pending",
            LOG_LEVEL_NOTICE
        );
        expect(pending.dependencies.preparation.prepareCentralRemote).not.toHaveBeenCalled();

        const offline = createHarness();
        vi.mocked(offline.dependencies.gates.isOnline).mockReturnValue(false);
        await expect(offline.evaluate()).resolves.toEqual({
            ready: false,
            purpose: "replication",
            rejectedCondition: "network-online",
        });
        expect(offline.dependencies.diagnostics.showError).toHaveBeenCalledWith("Network is offline", LOG_LEVEL_INFO);
        expect(offline.dependencies.preparation.prepareCentralRemote).not.toHaveBeenCalled();
    });
});
