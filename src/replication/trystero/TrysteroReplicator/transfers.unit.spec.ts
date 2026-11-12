import { LOG_LEVEL_INFO } from "octagonal-wheels/common/logger";
import type PouchDB from "pouchdb-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type EntryDoc } from "@lib/common/types";
import { VERSIONING_DOCID } from "@lib/common/models/db.const";
import type { ProgressInfo } from "@lib/pouchdb/ReplicatorShim";
import {
    createTransfers,
    replicateFrom as observePull,
    sync as synchronise,
    pullFromWithinSession,
    checkPeerForReplication,
    requestSynchroniseToPeer as requestReverseTransfer,
    type PullContext,
    type RequestSynchronisationContext,
    P2P_REPLICATION_CANCELLED,
    P2P_REPLICATION_COMPLETED,
    type TransferConnection,
    type TransferDependencies,
    type TransferHost,
    type P2PReplicationResult,
} from "./transfers";

function harness() {
    const trace: string[] = [];
    const missing = () => Object.assign(new Error("missing"), { status: 404, name: "not_found" });
    const local = {
        get: vi.fn(async () => {
            trace.push("local-identity");
            throw missing();
        }),
        info: vi.fn(async () => ({ db_name: "local", update_seq: 0 })),
    };
    const remote = {
        bulkGet: vi.fn(async () => {
            trace.push("remote-identity");
            return { results: [{ id: VERSIONING_DOCID, docs: [{ error: { status: 404, name: "not_found" } }] }] };
        }),
        info: vi.fn(async () => ({ db_name: "remote", update_seq: 0 })),
    };
    const requestSynchronisation = vi.fn(
        async (_timeoutMs: number, _signal?: AbortSignal) => P2P_REPLICATION_COMPLETED
    );
    const getRemoteDB = vi.fn(
        (_signal?: AbortSignal) => remote as unknown as ReturnType<TransferConnection["getRemoteDB"]>
    );
    const connection = vi.fn(() => ({ requestSynchronisation, getRemoteDB }));
    let host: TransferHost | undefined = { connection };
    const hostPort = vi.fn(() => host);
    const settings = { ...DEFAULT_SETTINGS };
    const replicate = vi.fn<TransferDependencies["replicate"]>(async () => ({ status: "completed" }));
    const processReplicatedDocs = vi.fn(async (_docs: Array<PouchDB.Core.ExistingDocument<EntryDoc>>) => {
        trace.push("processed");
    });
    const canStartOrdinaryReplication = vi.fn(async (_showMessage?: boolean) => true);
    const requestAuthenticate = vi.fn(async (_peerId: string, _signal?: AbortSignal) => {
        trace.push("auth");
        return true as boolean | undefined;
    });
    const checkTweakValues = vi.fn(async (..._args: Parameters<TransferDependencies["checkTweakValues"]>) => {
        trace.push("tweaks");
        return true;
    });
    const replicateFrom = vi.fn(
        async (..._args: Parameters<TransferDependencies["replicateFrom"]>) =>
            P2P_REPLICATION_COMPLETED as P2PReplicationResult
    );
    const requestSynchroniseToPeer = vi.fn(
        async (_peerId: string, _signal?: AbortSignal) => P2P_REPLICATION_COMPLETED as P2PReplicationResult
    );
    const progress = vi.fn((_peerId: string, info?: ProgressInfo) => {
        trace.push(info ? "progress-active" : "progress-end");
    });
    const acknowledgement = vi.fn((..._args: Parameters<TransferDependencies["acknowledgeProgress"]>) => {
        trace.push("ack");
    });
    const diagnostic = vi.fn();
    const notify = vi.fn((_exclude?: string) => {
        trace.push("notify");
        return Promise.resolve();
    });
    const transfers = createTransfers({
        host: hostPort,
        database: () => local as unknown as PouchDB.Database<EntryDoc>,
        currentSettings: () => settings,
        // Vitest records one instantiated call signature; retain the engine's generic contract at this mock boundary.
        replicate: replicate as TransferDependencies["replicate"],
        processReplicatedDocs,
        canStartOrdinaryReplication,
        requestAuthenticate,
        checkTweakValues,
        replicateFrom,
        requestSynchroniseToPeer,
        dispatchStatus: () => {
            trace.push(transfers.replicateFromPeers.has("peer") ? "active" : "released");
        },
        dispatchReplicationProgress: progress,
        acknowledgeProgress: acknowledgement,
        beginProgressAttempt: () => ({ attempt: 7 }),
        reportDiagnostic: diagnostic,
        notifyProgress: notify,
    });
    return {
        transfers,
        trace,
        local,
        remote,
        hostPort,
        connection,
        getRemoteDB,
        requestSynchronisation,
        settings,
        replicate,
        processReplicatedDocs,
        canStartOrdinaryReplication,
        requestAuthenticate,
        checkTweakValues,
        replicateFrom,
        requestSynchroniseToPeer,
        progress,
        acknowledgement,
        diagnostic,
        notify,
        removeHost: () => {
            host = undefined;
        },
    };
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("transfer state and orchestration", () => {
    it("constructs without starting host, policy, database, or replication work", () => {
        const h = harness();
        expect(h.transfers.availableReplicationPairs.size).toBe(0);
        expect(h.transfers.replicateFromPeers.size).toBe(0);
        expect(h.transfers.replicateToPeers.size).toBe(0);
        expect(h.hostPort).not.toHaveBeenCalled();
        expect(h.canStartOrdinaryReplication).not.toHaveBeenCalled();
        expect(h.replicate).not.toHaveBeenCalled();
        expect(h.trace).toEqual([]);
    });

    it("refuses ordinary work before agreement while retaining the explicit policy bypass", async () => {
        const h = harness();
        h.canStartOrdinaryReplication.mockResolvedValue(false);
        expect(await h.transfers.replicateFrom("peer", false, false, false)).toMatchObject({ status: "failed" });
        expect(h.requestAuthenticate).not.toHaveBeenCalled();
        expect(await h.transfers.replicateFrom("peer", false, true, true)).toBe(P2P_REPLICATION_COMPLETED);
        expect(h.canStartOrdinaryReplication).toHaveBeenCalledOnce();
        expect(h.replicate).toHaveBeenCalledOnce();
    });

    it.each(["auth-refused", "auth-aborted", "tweak-refused", "tweak-aborted", "tweak-error"] as const)(
        "retains agreement-before-active ordering for %s",
        async (ending) => {
            const h = harness();
            const controller = new AbortController();
            const error = new Error("tweak failed");
            if (ending.startsWith("auth")) {
                h.requestAuthenticate.mockImplementation(async () => {
                    if (ending === "auth-aborted") {
                        controller.abort();
                    }
                    return false;
                });
            } else {
                h.checkTweakValues.mockImplementation(async () => {
                    if (ending === "tweak-aborted") {
                        controller.abort();
                    }
                    if (ending === "tweak-error") {
                        throw error;
                    }
                    return false;
                });
            }
            const call = h.transfers.replicateFrom("peer", false, false, false, controller.signal);
            if (ending === "tweak-error") {
                await expect(call).rejects.toBe(error);
            } else {
                expect(await call).toMatchObject({ status: ending.endsWith("aborted") ? "cancelled" : "failed" });
            }
            expect(h.transfers.replicateFromPeers.size).toBe(0);
            expect(h.replicate).not.toHaveBeenCalled();
            expect(h.progress).not.toHaveBeenCalled();
        }
    );

    it("cancels an already-aborted pull before requesting peer agreement", async () => {
        const h = harness();
        const controller = new AbortController();
        controller.abort();

        expect(await h.transfers.replicateFrom("peer", false, false, false, controller.signal)).toBe(
            P2P_REPLICATION_CANCELLED
        );
        expect(h.canStartOrdinaryReplication).toHaveBeenCalledExactlyOnceWith(false);
        expect(h.requestAuthenticate).not.toHaveBeenCalled();
        expect(h.checkTweakValues).not.toHaveBeenCalled();
        expect(h.transfers.replicateFromPeers.size).toBe(0);
        expect(h.progress).not.toHaveBeenCalled();
        expect(h.replicate).not.toHaveBeenCalled();
    });

    it("forwards engine options and waits for document processing before notifying other peers", async () => {
        const h = harness();
        const controller = new AbortController();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        h.processReplicatedDocs.mockImplementation(async () => {
            await held;
            h.trace.push("processed");
        });
        const latest: ProgressInfo = { lastSeq: 5, maxSeqInBatch: 9, statistics: { documents: 1, checkedChanges: 3 } };
        h.replicate.mockImplementation(async (_target, _source, commitBatch, options) => {
            h.trace.push("engine");
            await commitBatch([], latest);
            options?.onStatistics?.(latest);
            return { status: "completed" };
        });
        const call = h.transfers.replicateFrom("peer", false, true, false, controller.signal);
        try {
            await vi.waitFor(() => expect(h.processReplicatedDocs).toHaveBeenCalledOnce());
            expect(h.notify).not.toHaveBeenCalled();
            expect(h.transfers.replicateFromPeers.has("peer")).toBe(true);
            release();
            expect(await call).toBe(P2P_REPLICATION_COMPLETED);
            expect(h.getRemoteDB).toHaveBeenCalledExactlyOnceWith(controller.signal);
            expect(h.replicate.mock.calls[0][0]).toBe(h.local);
            expect(h.replicate.mock.calls[0][1]).toBe(h.remote);
            expect(h.replicate.mock.calls[0][3]).toMatchObject({
                live: false,
                rewind: true,
                signal: controller.signal,
            });
            expect(h.notify).toHaveBeenCalledExactlyOnceWith("peer");
            expect(h.trace.indexOf("processed")).toBeLessThan(h.trace.indexOf("notify"));
            expect(h.trace.slice(0, 5)).toEqual(["auth", "tweaks", "active", "progress-active", "ack"]);
            expect(h.trace.slice(-3)).toEqual(["progress-end", "ack", "released"]);
            expect(h.acknowledgement).toHaveBeenLastCalledWith("peer", undefined, {
                attempt: 7,
                finalProgress: latest,
            });
            expect(h.transfers.replicateFromPeers.size).toBe(0);
            expect(h.diagnostic).toHaveBeenLastCalledWith({ category: "sync", code: "pull-completed", peerId: "peer" });
        } finally {
            release();
            await call;
        }
    });

    it.each(["error", "cancelled", "aborted-error"] as const)(
        "finalises active state after engine %s",
        async (ending) => {
            const h = harness();
            const controller = new AbortController();
            const error = new Error("engine failed");
            h.replicate.mockImplementation(async () => {
                if (ending === "cancelled") {
                    return { status: "cancelled" };
                }
                if (ending === "aborted-error") {
                    controller.abort();
                }
                throw error;
            });
            const result = await h.transfers.replicateFrom("peer", false, false, false, controller.signal);
            expect(result).toMatchObject(ending === "error" ? { status: "failed", error } : { status: "cancelled" });
            expect(h.transfers.replicateFromPeers.size).toBe(0);
            expect(h.trace.slice(-3)).toEqual(["progress-end", "ack", "released"]);
        }
    );

    it("rejects incompatible database identity before the engine is called", async () => {
        const h = harness();
        h.settings.pathNormalizationVersion = 1;
        expect(await h.transfers.replicateFrom("peer", false, false, false)).toMatchObject({ status: "failed" });
        expect(h.replicate).not.toHaveBeenCalled();
        expect(h.transfers.replicateFromPeers.size).toBe(0);
    });

    it("reports a missing host as a failed pull and releases active state", async () => {
        const h = harness();
        h.removeHost();

        const result = await h.transfers.replicateFrom("peer", false, false, false);

        expect(result).toMatchObject({
            status: "failed",
            error: expect.objectContaining({ message: "Server is not available" }),
        });
        expect(h.connection).not.toHaveBeenCalled();
        expect(h.getRemoteDB).not.toHaveBeenCalled();
        expect(h.transfers.replicateFromPeers.size).toBe(0);
    });

    it("retains agreement checks before refusing a duplicate active peer", async () => {
        const h = harness();
        h.transfers.replicateFromPeers.add("peer");
        expect(await h.transfers.replicateFrom("peer", false, false, false)).toMatchObject({ status: "failed" });
        expect(h.checkTweakValues).toHaveBeenCalledOnce();
        expect(h.replicate).not.toHaveBeenCalled();
        expect(h.transfers.replicateFromPeers.has("peer")).toBe(true);
    });

    it.each([P2P_REPLICATION_CANCELLED, { status: "failed", error: new Error("pull failed") } as P2PReplicationResult])(
        "does not request the reverse transfer after $status",
        async (result) => {
            const h = harness();
            h.replicateFrom.mockResolvedValue(result);
            expect(await h.transfers.sync("peer", true)).toBe(result);
            expect(h.replicateFrom).toHaveBeenCalledExactlyOnceWith("peer", true, false, false, undefined);
            expect(h.requestSynchroniseToPeer).not.toHaveBeenCalled();
        }
    );

    it("uses the public-dispatch ports for a successful bidirectional synchronisation", async () => {
        const h = harness();
        const controller = new AbortController();
        expect(await h.transfers.sync("peer", false, controller.signal)).toBe(P2P_REPLICATION_COMPLETED);
        expect(h.replicateFrom).toHaveBeenCalledExactlyOnceWith("peer", false, false, false, controller.signal);
        expect(h.requestSynchroniseToPeer).toHaveBeenCalledExactlyOnceWith("peer", controller.signal);
        expect(h.replicate).not.toHaveBeenCalled();
    });

    it("cancels bidirectional synchronisation if the pull aborts before the reverse request", async () => {
        const h = harness();
        const controller = new AbortController();
        h.replicateFrom.mockImplementation(async () => {
            controller.abort();
            return P2P_REPLICATION_COMPLETED;
        });

        expect(await h.transfers.sync("peer", false, controller.signal)).toBe(P2P_REPLICATION_CANCELLED);
        expect(h.requestSynchroniseToPeer).not.toHaveBeenCalled();
    });

    it("returns a failed reverse request from bidirectional synchronisation", async () => {
        const h = harness();
        const failure: P2PReplicationResult = { status: "failed", error: new Error("reverse request failed") };
        h.requestSynchroniseToPeer.mockResolvedValue(failure);

        expect(await h.transfers.sync("peer", true)).toBe(failure);
        expect(h.requestSynchroniseToPeer).toHaveBeenCalledExactlyOnceWith("peer", undefined);
    });

    it("observes cancellation during the existing reverse-request scheduling delay", async () => {
        vi.useFakeTimers();
        const h = harness();
        const controller = new AbortController();
        const call = h.transfers.requestSynchroniseToPeer("peer", controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(25);
        expect(await call).toBe(P2P_REPLICATION_CANCELLED);
        expect(h.hostPort).not.toHaveBeenCalled();
    });

    it("retains the reverse request's zero RPC deadline and caller signal", async () => {
        vi.useFakeTimers();
        const h = harness();
        const controller = new AbortController();
        const call = h.transfers.requestSynchroniseToPeer("peer", controller.signal);
        await vi.advanceTimersByTimeAsync(25);
        expect(await call).toBe(P2P_REPLICATION_COMPLETED);
        expect(h.requestSynchronisation).toHaveBeenCalledExactlyOnceWith(0, controller.signal);
    });

    it("cancels an already-aborted reverse request before waiting", async () => {
        const controller = new AbortController();
        controller.abort();
        const canStartOrdinaryReplication = vi.fn(async (_showMessage?: boolean) => true);
        const host = vi.fn(() => undefined);
        const context: RequestSynchronisationContext = { deps: { canStartOrdinaryReplication, host } };

        expect(await requestReverseTransfer(context, "peer", controller.signal)).toBe(P2P_REPLICATION_CANCELLED);
        expect(canStartOrdinaryReplication).toHaveBeenCalledExactlyOnceWith(false);
        expect(host).not.toHaveBeenCalled();
    });

    it("propagates a missing host after the reverse-request scheduling delay", async () => {
        vi.useFakeTimers();
        const canStartOrdinaryReplication = vi.fn(async (_showMessage?: boolean) => true);
        const host = vi.fn(() => undefined);
        const context: RequestSynchronisationContext = { deps: { canStartOrdinaryReplication, host } };
        const call = requestReverseTransfer(context, "peer");
        const rejection = expect(call).rejects.toThrow("Server is not available");
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(host).toHaveBeenCalledOnce();
    });

    it("returns cancellation when the reverse RPC rejects after the caller aborts", async () => {
        vi.useFakeTimers();
        const h = harness();
        const controller = new AbortController();
        const error = new Error("RPC cancelled");
        let rejectRPC!: (reason: Error) => void;
        const pendingRPC = new Promise<never>((_resolve, reject) => {
            rejectRPC = reject;
        });
        h.requestSynchronisation.mockImplementation(async () => pendingRPC);
        const call = h.transfers.requestSynchroniseToPeer("peer", controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(25);
        controller.abort();
        rejectRPC(error);

        expect(await call).toBe(P2P_REPLICATION_CANCELLED);
        expect(h.requestSynchronisation).toHaveBeenCalledExactlyOnceWith(0, controller.signal);
    });

    it("propagates a non-cancellation error from the reverse RPC", async () => {
        vi.useFakeTimers();
        const h = harness();
        const error = new Error("RPC unavailable");
        h.requestSynchronisation.mockRejectedValue(error);
        const call = h.transfers.requestSynchroniseToPeer("peer");
        const rejection = expect(call).rejects.toBe(error);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(h.requestSynchronisation).toHaveBeenCalledExactlyOnceWith(0, undefined);
    });

    it("fans out to every available peer and waits for each request to settle", async () => {
        vi.useFakeTimers();
        const h = harness();
        h.transfers.availableReplicationPairs.add("peer-a");
        h.transfers.availableReplicationPairs.add("peer-b");
        let releasePeerB!: () => void;
        const peerB = new Promise<void>((resolve) => {
            releasePeerB = resolve;
        });
        h.requestSynchroniseToPeer.mockImplementation(async (peerId) => {
            if (peerId === "peer-b") {
                await peerB;
            }
            return P2P_REPLICATION_COMPLETED;
        });
        const call = h.transfers.requestSynchroniseToAllAvailablePeers();
        let settled = false;
        void call.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(25);

        expect(h.requestSynchroniseToPeer.mock.calls).toEqual([["peer-a"], ["peer-b"]]);
        expect(settled).toBe(false);
        releasePeerB();
        await expect(call).resolves.toBeUndefined();
        expect(settled).toBe(true);
    });

    it("propagates a failed request from the available-peer fan-out", async () => {
        vi.useFakeTimers();
        const h = harness();
        h.transfers.availableReplicationPairs.add("peer-a");
        h.transfers.availableReplicationPairs.add("peer-b");
        const error = new Error("peer-b request failed");
        h.requestSynchroniseToPeer.mockImplementation(async (peerId) => {
            if (peerId === "peer-b") {
                throw error;
            }
            return P2P_REPLICATION_COMPLETED;
        });
        const call = h.transfers.requestSynchroniseToAllAvailablePeers();
        const rejection = expect(call).rejects.toBe(error);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(25);

        await rejection;
        expect(h.requestSynchroniseToPeer.mock.calls).toEqual([["peer-a"], ["peer-b"]]);
    });

    it("clears active sets without discarding available targets or duplicating replaced state", () => {
        const h = harness();
        const active = new Set(["peer"]);
        h.transfers.replicateFromPeers = active;
        h.transfers.replicateToPeers.add("other");
        h.transfers.availableReplicationPairs.add("available");
        h.transfers.clearActivePeers();
        expect(active.size).toBe(0);
        expect(h.transfers.replicateToPeers.size).toBe(0);
        expect([...h.transfers.availableReplicationPairs]).toEqual(["available"]);
    });
});

describe("transfer operations with function-specific capabilities", () => {
    it.each([
        P2P_REPLICATION_COMPLETED,
        P2P_REPLICATION_CANCELLED,
        { status: "failed", error: new Error("private details") } as P2PReplicationResult,
    ])("observes a $status pull with only a reporter and a pull operation", async (outcome) => {
        const controller = new AbortController();
        const reportDiagnostic = vi.fn();
        const pull = vi.fn(async (..._args: Parameters<TransferDependencies["replicateFrom"]>) => outcome);
        const result = await observePull(
            { deps: { reportDiagnostic }, pullFromWithinSession: pull },
            "peer",
            true,
            true,
            false,
            controller.signal
        );
        expect(result).toBe(outcome);
        expect(pull).toHaveBeenCalledExactlyOnceWith("peer", true, true, false, controller.signal);
        expect(reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual([
            "pull-started",
            `pull-${outcome.status}`,
        ]);
        expect(JSON.stringify(reportDiagnostic.mock.calls)).not.toContain("private details");
    });

    it("preserves a thrown pull error without needing transfer state or a database", async () => {
        const error = new Error("pull unavailable");
        const reportDiagnostic = vi.fn();
        await expect(
            observePull(
                {
                    deps: { reportDiagnostic },
                    pullFromWithinSession: async () => {
                        throw error;
                    },
                },
                "peer",
                false,
                false,
                false
            )
        ).rejects.toBe(error);
        expect(reportDiagnostic.mock.calls.map(([event]) => event.code)).toEqual(["pull-started", "pull-failed"]);
    });

    it("composes bidirectional sync from only pull and reverse-request capabilities", async () => {
        const replicateFrom = vi.fn<TransferDependencies["replicateFrom"]>(async () => P2P_REPLICATION_COMPLETED);
        const requestSynchroniseToPeer = vi.fn<TransferDependencies["requestSynchroniseToPeer"]>(
            async () => P2P_REPLICATION_COMPLETED
        );
        const controller = new AbortController();
        expect(
            await synchronise({ deps: { replicateFrom, requestSynchroniseToPeer } }, "peer", false, controller.signal)
        ).toBe(P2P_REPLICATION_COMPLETED);
        expect(replicateFrom).toHaveBeenCalledExactlyOnceWith("peer", false, false, false, controller.signal);
        expect(requestSynchroniseToPeer).toHaveBeenCalledExactlyOnceWith("peer", controller.signal);
    });

    it("rejects admission with only the two agreement capabilities", async () => {
        const requestAuthenticate = vi.fn(async () => false);
        const checkTweakValues = vi.fn(async () => true);
        const result = await checkPeerForReplication(
            { deps: { requestAuthenticate, checkTweakValues } },
            "peer",
            LOG_LEVEL_INFO
        );
        expect(result).toMatchObject({ status: "failed" });
        expect(requestAuthenticate).toHaveBeenCalledExactlyOnceWith("peer");
        expect(checkTweakValues).not.toHaveBeenCalled();
    });

    it("does not need progress, database, or discovery capabilities to refuse a reverse request", async () => {
        const host = vi.fn();
        const canStartOrdinaryReplication = vi.fn(async () => false);
        expect(await requestReverseTransfer({ deps: { host, canStartOrdinaryReplication } }, "peer")).toMatchObject({
            status: "failed",
        });
        expect(canStartOrdinaryReplication).toHaveBeenCalledExactlyOnceWith(false);
        expect(host).not.toHaveBeenCalled();
    });

    it("owns the pull lifecycle while agreement and database transfer are supplied operations", async () => {
        const state = { replicateFromPeers: new Set<string>() };
        const trace: string[] = [];
        const finalAcknowledgement = vi.fn();
        const context: PullContext = {
            state,
            deps: {
                canStartOrdinaryReplication: async () => true,
                dispatchStatus: () => {
                    trace.push(state.replicateFromPeers.has("peer") ? "active" : "released");
                },
                beginProgressAttempt: () => ({ attempt: 19 }),
                dispatchReplicationProgress: (_peer, info) => {
                    trace.push(info ? "progress" : "end");
                },
                acknowledgeProgress: finalAcknowledgement,
            },
            checkPeerForReplication: async () => {
                trace.push("agreement");
                return undefined;
            },
            transferFromPeer: async () => {
                expect(state.replicateFromPeers.has("peer")).toBe(true);
                trace.push("transfer");
                return P2P_REPLICATION_COMPLETED;
            },
        };
        expect(await pullFromWithinSession(context, "peer", false, false, false)).toBe(P2P_REPLICATION_COMPLETED);
        expect(trace).toEqual(["agreement", "active", "progress", "transfer", "end", "released"]);
        expect(finalAcknowledgement).toHaveBeenLastCalledWith("peer", undefined, {
            attempt: 19,
            finalProgress: { lastSeq: 0, maxSeqInBatch: 0, statistics: { documents: 0, checkedChanges: 0 } },
        });
        expect(state.replicateFromPeers.size).toBe(0);
    });
});
