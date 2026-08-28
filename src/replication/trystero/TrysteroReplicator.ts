import type PouchDB from "pouchdb-core";
import { TweakValuesShouldMatchedTemplate, type EntryDoc, type ObsidianLiveSyncSettings } from "@lib/common/types";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { replicateShim, type ProgressInfo } from "@lib/pouchdb/ReplicatorShim";
import type { Confirm } from "@lib/interfaces/Confirm";
import { type Advertisement, type ReplicatorHostEnv } from "./types";
import { scheduleOnceIfDuplicated, serialized, skipIfDuplicated } from "octagonal-wheels/concurrency/lock_v2";
import { delay, fireAndForget } from "octagonal-wheels/promises";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_P2P_REPLICATOR_STATUS,
    P2PHost,
    type P2PPeerAcceptance,
} from "./TrysteroReplicatorP2PServer";
import { encryptWithEphemeralSalt, decryptWithEphemeralSalt } from "octagonal-wheels/encryption/hkdf";
import { sha1 } from "octagonal-wheels/hash/purejs";
import { isObjectDifferent } from "octagonal-wheels/object";
import { getRelaySockets, pauseRelayReconnection, resumeRelayReconnection } from "@trystero-p2p/nostr";
import type { P2PFiniteOperationOwner } from "./P2PRoomSession";
import { P2PAutomationCoordinator } from "./P2PAutomationCoordinator";
import { compatGlobal, type CompatTimeoutHandle } from "@lib/common/coreEnvFunctions";

async function encrypt(data: string, passphrase: string) {
    return await encryptWithEphemeralSalt(data, passphrase, true);
}
async function decrypt(encryptedData: string, passphrase: string) {
    return await decryptWithEphemeralSalt(encryptedData, passphrase);
}

export type P2PReplicatorStatus = {
    isBroadcasting: boolean;
    replicatingTo: string[];
    replicatingFrom: string[];
    watchingPeers: string[];
};
export type P2PReplicationProgress = {
    peerId: string;
    peerName: string;
    fetching: {
        max: number;
        current: number;
        isActive: boolean;
    };
    sending: {
        max: number;
        current: number;
        isActive: boolean;
    };
};
export type P2PReplicationReport = {
    peerId: string;
    peerName: string;
} & (
    | {
          fetching: {
              max: number;
              current: number;
              isActive: boolean;
          };
      }
    | {
          sending: {
              max: number;
              current: number;
              isActive: boolean;
          };
      }
);

export type P2PReplicationResult =
    | { readonly status: "completed"; readonly ok: true; readonly error?: never }
    | { readonly status: "cancelled"; readonly ok?: false; readonly error?: never }
    | { readonly status: "failed"; readonly ok?: false; readonly error: unknown };

export type P2PConfiguredTargetResult = {
    readonly name: string;
    readonly peerId?: string;
} & (
    | { readonly status: "completed" }
    | { readonly status: "cancelled" }
    | { readonly status: "missing" }
    | { readonly status: "rejected" }
    | { readonly status: "undecided" }
    | { readonly status: "failed"; readonly error: unknown }
);

/** Explicit result of configured, unattended P2P target synchronisation. */
export type P2PConfiguredReplicationResult =
    | { readonly status: "completed"; readonly targets: readonly P2PConfiguredTargetResult[] }
    | { readonly status: "cancelled"; readonly targets: readonly P2PConfiguredTargetResult[] }
    | { readonly status: "blocked"; readonly reason: "no-targets"; readonly targets: readonly [] }
    | { readonly status: "partial"; readonly targets: readonly P2PConfiguredTargetResult[] };

const P2P_REPLICATION_COMPLETED = Object.freeze({ status: "completed", ok: true } as const);
const P2P_REPLICATION_CANCELLED = Object.freeze({ status: "cancelled" } as const);

function p2pReplicationFailed(error: unknown): P2PReplicationResult {
    return { status: "failed", error };
}

function isP2PReplicationCancelled(result: P2PReplicationResult): boolean {
    return result.status === "cancelled";
}

declare global {
    interface LSEvents {
        [EVENT_P2P_REPLICATOR_STATUS]: P2PReplicatorStatus;
        [EVENT_P2P_REPLICATOR_PROGRESS]: P2PReplicationReport;
    }
}

export type AllReplicationClientStatus = {
    [peerId: string]: {
        isReplicatingTo: boolean;
        isReplicatingFrom: boolean;
        isWatching: boolean;
        stats: P2PReplicationProgress;
    };
};

async function getHashedStringWithCurrentTime(source: string) {
    const salt = (~~(new Date().getTime() / 1000 / 180)).toString(36);
    const salt2 = await sha1(salt);
    return await sha1(salt2 + source);
}

export class TrysteroReplicator {
    _env: ReplicatorHostEnv;
    private readonly finiteOperationOwner?: P2PFiniteOperationOwner;
    private disposed = false;
    private readonly fallbackAutomationCoordinator = new P2PAutomationCoordinator();

    server?: P2PHost;
    replicationStatus() {
        return {};
    }

    get settings() {
        return this._env.settings;
    }
    get db(): PouchDB.Database<EntryDoc> {
        return this._env.db;
    }
    get deviceName(): string {
        return this._env.deviceName;
    }
    get platform(): string {
        return this._env.platform;
    }
    get confirm(): Confirm {
        return this._env.confirm;
    }
    get translate() {
        return this._env.translate;
    }

    private get automationCoordinator(): P2PAutomationCoordinator {
        return this._env.automationCoordinator ?? this.fallbackAutomationCoordinator;
    }

    private async runFiniteReplicationActivity<T>(task: () => T | PromiseLike<T>): Promise<T> {
        if (this._env.runFiniteReplicationActivity) {
            return await this._env.runFiniteReplicationActivity(task, { label: "replication" });
        }
        return await task();
    }

    private async canStartOrdinaryReplication(showMessage: boolean = false): Promise<boolean> {
        return this._env.canStartOrdinaryReplication ? await this._env.canStartOrdinaryReplication(showMessage) : true;
    }

    constructor(env: ReplicatorHostEnv, server?: P2PHost, finiteOperationOwner?: P2PFiniteOperationOwner) {
        this._env = env;
        this.finiteOperationOwner = finiteOperationOwner;
        if (server) {
            this.server = server;
            return;
        }
        try {
            if (!this.settings.P2P_Enabled) {
                Logger("P2P is not enabled", LOG_LEVEL_VERBOSE);
                return;
            }
            if (!this.settings.P2P_AppID) {
                throw new Error("P2P App ID is not provided. We need it to establish the P2P connection");
            }
            if (!this.settings.P2P_roomID || !this.settings.P2P_passphrase) {
                throw new Error(
                    "Room ID and/or P2P Passphrase have not provided. We need them to establish the P2P connection"
                );
            }
            if (!this.settings.P2P_relays || this.settings.P2P_relays.length === 0) {
                throw new Error("No relay URIs provided. We need them to establish the P2P connection");
            }
            this.server = new P2PHost(env);
        } catch (e) {
            Logger(e instanceof Error ? e.message : "Error while creating TrysteroReplicator", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            throw e;
        }
    }

    private async runSessionFiniteOperation<T>(
        task: (signal?: AbortSignal) => T | PromiseLike<T>,
        callerSignal?: AbortSignal
    ): Promise<T> {
        if (this.finiteOperationOwner) {
            return await this.finiteOperationOwner.runFiniteOperation(task, callerSignal);
        }
        return await task(callerSignal);
    }

    async close() {
        this.requestStatus();
        await this.server?.shutdown();
        this._replicateFromPeers.clear();
        this._replicateToPeers.clear();
        this._watchingPeers.clear();
        this.requestStatus();
        this.disconnectFromServer();
    }

    /** Close the transport and release resources owned for this object's lifetime. */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        try {
            await this.close();
        } finally {
            this.server?.dispose();
        }
    }

    async open() {
        if (this.disposed) {
            throw new Error("The P2P Replicator has been disposed.");
        }
        this.allowReconnection();
        const commands = this.getCommands();
        await this.server?.start([commands], () =>
            this.server?.serveCancellationAwareFunction<[string], P2PReplicationResult>(
                "reqSync",
                async ({ signal }, _peerId, fromPeerId) => await this.handleSynchronisationRequest(fromPeerId, signal)
            )
        );
        this.dispatchStatus();
        if (this.settings.P2P_AutoBroadcast) {
            this.enableBroadcastChanges();
        }
    }
    async makeSureOpened() {
        if (!this.server?.isServing) {
            await this.open();
        }
    }
    get autoSyncPeers() {
        const peers = this.settings.P2P_AutoSyncPeers.split(",")
            .map((e) => e.trim())
            .filter((e) => e.length > 0)
            .map((e) => (e.startsWith("~") ? new RegExp(e.substring(1), "i") : new RegExp(`^${e}$`, "i")));
        return peers;
    }
    get autoWatchPeers() {
        const peers = this.settings.P2P_AutoWatchPeers.split(",")
            .map((e) => e.trim())
            .filter((e) => e.length > 0)
            .map((e) => (e.startsWith("~") ? new RegExp(e.substring(1), "i") : new RegExp(`^${e}$`, "i")));
        return peers;
    }
    async onNewPeer(peer: Advertisement) {
        const peerName = peer.name;
        const shouldAutoSync = this.autoSyncPeers.some((e) => e.test(peerName));
        const shouldAutoWatch = this.autoWatchPeers.some((e) => e.test(peerName));
        if (!shouldAutoSync && !shouldAutoWatch) return;

        const acceptance = await this.server?.evaluatePeerAcceptance(peer.peerId);
        if (acceptance !== "accepted") return;

        if (shouldAutoSync) {
            await this.automationCoordinator.runBaseline(peerName, () =>
                this.runFiniteReplicationActivity(() => this.sync(peer.peerId))
            );
        }
        if (shouldAutoWatch && (await this.getRemoteIsBroadcasting(peer.peerId)) === true) {
            this.watchPeer(peer.peerId);
        }
    }
    onPeerLeaved(peerId: string) {
        void this.unwatchPeer(peerId);
    }
    _onSetup = false;
    setOnSetup() {
        this._onSetup = true;
    }
    clearOnSetup() {
        this._onSetup = false;
    }

    async getTweakSettings(fromPeerId: string) {
        const allSettings = JSON.parse(JSON.stringify(this.settings)) as Partial<ObsidianLiveSyncSettings>;
        for (const key in allSettings) {
            if (key == "encrypt") {
                continue;
            }
            if (key == "passphrase") {
                // If the passphrase is not matched, id of chunks will be different among the peers.
                allSettings[key] = await getHashedStringWithCurrentTime(allSettings[key] ?? "");
                continue;
            }
            if (!(key in TweakValuesShouldMatchedTemplate)) {
                delete allSettings[key as keyof ObsidianLiveSyncSettings];
            }
        }
        return allSettings;
    }

    private async handleSynchronisationRequest(
        fromPeerId: string,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        if (this._onSetup) {
            return p2pReplicationFailed(new Error("The setup is in progress"));
        }
        return await this.runFiniteReplicationActivity(() =>
            signal ? this.replicateFrom(fromPeerId, false, false, false, signal) : this.replicateFrom(fromPeerId)
        );
    }

    getCommands() {
        return {
            // The wire-visible command deliberately accepts only serialisable
            // arguments. RpcRoom supplies cancellation context separately.
            reqSync: async (fromPeerId: string): Promise<P2PReplicationResult> =>
                await this.handleSynchronisationRequest(fromPeerId),
            "!reqAuth": async (fromPeerId: string) => {
                return await this.server?.isAcceptablePeer(fromPeerId);
            },
            getTweakSettings: async (fromPeerId: string) => {
                return await this.getTweakSettings(fromPeerId);
            },
            onProgress: async (fromPeerId: string) => {
                if (this._onSetup) {
                    return { error: new Error("The setup is in progress") };
                }
                await this.onUpdateDatabase(fromPeerId);
            },
            getAllConfig: async (fromPeerId: string) => {
                if (this._onSetup) {
                    return { error: new Error("The setup is in progress") };
                }
                const passphrase = await skipIfDuplicated(`getAllConfig-${fromPeerId}`, async () => {
                    return await this.confirm.askString(
                        "Passphrase required",
                        this.translate("P2P.AskPassphraseForShare"),
                        "something you only know",
                        true
                    );
                });
                const setting = {
                    ...this.settings,
                    configPassphraseStore: "",
                    encryptedCouchDBConnection: "",
                    encryptedPassphrase: "",
                    pluginSyncExtendedSetting: {},
                } as Partial<ObsidianLiveSyncSettings>;
                if (!passphrase || passphrase.trim() == "") {
                    Logger(
                        "Passphrase is required to transfer the configuration. The peer cannot be decrypt the config\nIf you repeatedly receive unintended configuration-sharing requests, change the RPC channel immediately. It allows you to leave the connection and disappear, while they are trying brute force attack for the decoy on their local.",
                        LOG_LEVEL_NOTICE
                    );
                    const r = JSON.stringify(
                        Object.fromEntries(
                            Object.entries(setting).map(([key, value]) => {
                                return [key, "******".repeat(Math.ceil(Math.random() * 10) + 2)];
                            })
                        )
                    );
                    const randomString = Math.random().toString(36).substring(7);
                    // Harassment and stalling for intruders
                    return encrypt(r, randomString);
                }
                return encrypt(JSON.stringify(setting), passphrase.trim());
            },
            onProgressAcknowledged: async (fromPeerId: string, info: ProgressInfo) => {
                try {
                    await Promise.resolve(this.onProgressAcknowledged(fromPeerId, info));
                } catch (e) {
                    Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
                    Logger(e, LOG_LEVEL_VERBOSE);
                }
            },
            getIsBroadcasting: () => {
                return Promise.resolve(this._isBroadcasting);
            },
            requestBroadcasting: async (peerId: string) => {
                if (this._onSetup) {
                    return { error: new Error("The setup is in progress") };
                }
                if (this._isBroadcasting) {
                    return true;
                }
                if (
                    (await skipIfDuplicated(
                        `requested-${peerId}`,
                        async () =>
                            await this.confirm.askYesNoDialog(
                                "The remote peer requested to broadcast the changes. Do you want to allow it?",
                                { defaultOption: "No" }
                            )
                    )) === "yes"
                ) {
                    this.enableBroadcastChanges();
                }
            },
        };
    }

    async requestAuthenticate(peerId: string, signal?: AbortSignal) {
        if (!this.server) return false;
        try {
            const connection = this.server.getConnection(peerId);
            const selfPeerId = this.server.serverPeerId;
            const r = await connection.invokeRemoteObjectFunction<ReturnType<typeof this.getCommands>, "!reqAuth">(
                "!reqAuth",
                [selfPeerId],
                20000,
                signal
            );
            return r;
        } catch (e) {
            Logger("Error while requesting authentication", LOG_LEVEL_VERBOSE);
            Logger(e, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    lastSeq = "" as string | number;
    async requestSynchroniseToPeer(peerId: string, callerSignal?: AbortSignal): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) => await this.requestSynchroniseToPeerWithinSession(peerId, signal),
            callerSignal
        );
    }

    private async requestSynchroniseToPeerWithinSession(
        peerId: string,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        if (!(await this.canStartOrdinaryReplication(false))) {
            return p2pReplicationFailed(new Error("Replication is not ready"));
        }
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        await delay(25);
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        if (!this.server) throw new Error("Server is not available");
        // Logger(`P2P requesting remote sync from ${peerId}`, LOG_LEVEL_NOTICE, "p2p-replicator");
        const conn = this.server.getConnection(peerId);
        try {
            const result = await conn.invokeRemoteFunction<
                [string],
                Awaited<ReturnType<ReturnType<typeof this.getCommands>["reqSync"]>>
            >("reqSync", [this.server.serverPeerId], 0, signal);
            // Logger(`P2P remote sync request returned from ${peerId}`, LOG_LEVEL_NOTICE, "p2p-replicator");
            return result;
        } catch (error) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            throw error;
        }
    }

    async requestSynchroniseToAllAvailablePeers() {
        await scheduleOnceIfDuplicated("requestSynchroniseToAllAvailablePeers", async () => {
            await delay(25);
            const replications = [...this.availableReplicationPairs].map((peerId) => {
                return this.requestSynchroniseToPeer(peerId);
            });
            await Promise.all(replications);
        });
    }

    dispatchStatus() {
        if (this.disposed) return;
        this._env.events.emitEvent(EVENT_P2P_REPLICATOR_STATUS, {
            isBroadcasting: this._isBroadcasting,
            replicatingTo: [...this._replicateToPeers],
            replicatingFrom: [...this._replicateFromPeers],
            watchingPeers: [...this._watchingPeers],
        });
    }
    requestStatus() {
        this.dispatchStatus();
        void this.server?.dispatchConnectionStatus();
    }

    changes?: PouchDB.Core.Changes<EntryDoc>;
    _isBroadcasting = false;
    disableBroadcastChanges() {
        this.changes?.cancel();
        this._isBroadcasting = false;
        this.dispatchStatus();
    }

    enableBroadcastChanges() {
        if (this._isBroadcasting) return;
        this._isBroadcasting = true;
        this.dispatchStatus();
        if (this.changes) {
            void this.changes.cancel();
            void this.changes.removeAllListeners();
        }
        this.changes = this.db.changes({
            since: "now",
            live: true,
            include_docs: false,
            selector: {
                _id: {
                    $gt: "_local/",
                },
            },
        });
        void this.changes.on("change", async (change) => {
            this.lastSeq = change.seq;
            await this.notifyProgress();
        });
        const closeChanges = (reason?: unknown) => {
            if (reason) {
                if (reason instanceof Error) {
                    Logger(`Error while broadcasting the changes`, LOG_LEVEL_INFO);
                    Logger(reason, LOG_LEVEL_VERBOSE);
                } else {
                    Logger(`Broadcasting the changes has been finished`, LOG_LEVEL_INFO);
                    Logger(reason, LOG_LEVEL_VERBOSE);
                }
            }
            void this.changes?.cancel();
            void this.changes?.removeAllListeners();
            this.changes = undefined;
            this._isBroadcasting = false;
            this.dispatchStatus();
        };
        void this.changes.on("error", closeChanges);
        void this.changes.on("complete", closeChanges);
        fireAndForget(async () => await this.notifyProgress());
    }

    get knownAdvertisements() {
        return this.server?.knownAdvertisements ?? [];
    }
    availableReplicationPairs = new Set<string>();

    async sync(
        remotePeer: string,
        showNotice: boolean = false,
        callerSignal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) => await this.syncWithinSession(remotePeer, showNotice, signal),
            callerSignal
        );
    }

    private async syncWithinSession(
        remotePeer: string,
        showNotice: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        const from = await this.replicateFrom(remotePeer, showNotice, false, false, signal);
        if (isP2PReplicationCancelled(from)) return from;
        if (from.error) {
            Logger("Error while replicating from the remote", LOG_LEVEL_VERBOSE);
            Logger(from.error, LOG_LEVEL_VERBOSE);
            return from;
        }
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        Logger(`P2P Replication has been requested to ${remotePeer}`, logLevel, "p2p-replicator");

        const res = await this.requestSynchroniseToPeer(remotePeer, signal);
        if (res.ok) {
            Logger("P2P Replication has been done", logLevel, "p2p-replicator");
        }
        if (res.error) {
            Logger("Error while syncing from the remote", logLevel, "p2p-replicator");
            Logger(res.error, LOG_LEVEL_VERBOSE);
        }
        // Logger(`P2P sync finished with ${remotePeer}`, LOG_LEVEL_NOTICE, "p2p-replicator");
        return res;
    }

    _replicateToPeers = new Set<string>();
    _replicateFromPeers = new Set<string>();

    dispatchReplicationProgress(peerId: string, info?: ProgressInfo) {
        this.onReplicationProgress(peerId, info);
    }
    onReplicationProgress(peerId: string, info?: ProgressInfo) {
        const name = this.server?._knownAdvertisements.get(peerId)?.name || peerId;
        const stat = {
            peerId,
            peerName: name,
            fetching: {
                max: 0,
                current: 0,
                isActive: false,
            },
        };
        if (info) {
            stat.fetching = {
                max: info.maxSeqInBatch,
                current: info.lastSeq,
                isActive: true,
            };
        }
        // console.warn(`Own Progress ${peerId}`, stat);
        this._env.events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, stat);
        return true;
    }
    onProgressAcknowledged(peerId: string, info?: ProgressInfo) {
        // const peerId = info
        const name = this.server?._knownAdvertisements.get(peerId)?.name || peerId;
        const ack = {
            peerId,
            peerName: name,
            sending: {
                max: 0,
                current: 0,
                isActive: false,
            },
        };
        if (info) {
            ack.sending = {
                max: info.maxSeqInBatch,
                current: info.lastSeq,
                isActive: true,
            };
        }
        // console.warn(`Progress acknowledged from ${peerId}`, ack);
        this._env.events.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, ack);
        return true;
    }
    // Sending the progress to the remote peer
    acknowledgeProgress(remotePeerId: string, info?: ProgressInfo) {
        if (!this.server) return;
        const connection = this.server.getConnection(remotePeerId);
        void connection
            .invokeRemoteFunction("onProgressAcknowledged", [this.server.serverPeerId, info], 500)
            .catch((ex) => {
                Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
                Logger(ex, LOG_LEVEL_VERBOSE);
            });
    }
    async replicateFrom(
        remotePeer: string,
        showNotice: boolean = false,
        fromStart = false,
        skipOrdinaryReplicationPolicy = false,
        callerSignal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        return await this.runSessionFiniteOperation(
            async (signal) =>
                await this.replicateFromWithinSession(
                    remotePeer,
                    showNotice,
                    fromStart,
                    skipOrdinaryReplicationPolicy,
                    signal
                ),
            callerSignal
        );
    }

    private async replicateFromWithinSession(
        remotePeer: string,
        showNotice: boolean,
        fromStart: boolean,
        skipOrdinaryReplicationPolicy: boolean,
        signal?: AbortSignal
    ): Promise<P2PReplicationResult> {
        // Explicit Fetch/Rebuild flows have their own destructive-operation
        // confirmation and must remain available while ordinary replication is paused.
        if (!skipOrdinaryReplicationPolicy && !(await this.canStartOrdinaryReplication(showNotice))) {
            return p2pReplicationFailed(new Error("Replication is not ready"));
        }
        if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
        const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        Logger(`P2P Requesting Authentication to ${remotePeer}`, logLevel, "p2p-replicator");
        const authenticated = signal
            ? await this.requestAuthenticate(remotePeer, signal)
            : await this.requestAuthenticate(remotePeer);
        if (authenticated !== true) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            Logger("Peer rejected the connection", LOG_LEVEL_NOTICE, "p2p-replicator");
            return p2pReplicationFailed(new Error("Peer rejected the connection"));
        }

        let tweaksMatched: boolean;
        try {
            tweaksMatched = signal
                ? await this.checkTweakValues(remotePeer, signal)
                : await this.checkTweakValues(remotePeer);
        } catch (error) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            throw error;
        }
        if (tweaksMatched !== true) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            Logger("Tweak values are not matched", LOG_LEVEL_NOTICE, "p2p-replicator");
            return p2pReplicationFailed(new Error("Tweak values are not matched"));
        }

        Logger(`P2P Replicating from ${remotePeer}`, logLevel, "p2p-replicator");
        if (this._replicateFromPeers.has(remotePeer)) {
            Logger(`Replication from ${remotePeer} is already in progress`, LOG_LEVEL_NOTICE, "p2p-replicator");
            return p2pReplicationFailed(new Error("Replication from this peer is already in progress"));
        }
        this._replicateFromPeers.add(remotePeer);
        this.dispatchStatus();

        try {
            if (!this.server) {
                throw new Error("Server is not available");
            }
            const connection = this.server.getConnection(remotePeer);
            const remoteDB = connection.getRemoteDB(signal);
            Logger(`P2P replicateFrom preparing remote DB info for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
            const remoteDBInfo = await remoteDB.info();
            Logger(
                `P2P replicateFrom remote DB info for ${remotePeer}: ${remoteDBInfo.db_name} seq=${remoteDBInfo.update_seq}`,
                LOG_LEVEL_VERBOSE,
                "p2p-replicator"
            );
            const localDBInfo = await this.db.info();
            Logger(
                `P2P replicateFrom local DB info for ${remotePeer}: ${localDBInfo.db_name} seq=${localDBInfo.update_seq}`,
                LOG_LEVEL_VERBOSE,
                "p2p-replicator"
            );
            Logger(`P2P replicateFrom entering replicateShim for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
            // const batchSize = 8;
            const outcome = await replicateShim(
                this.db,
                remoteDB,
                async (docs, info) => {
                    await this._env.processReplicatedDocs(docs as Array<PouchDB.Core.ExistingDocument<EntryDoc>>);
                    void this.dispatchReplicationProgress(remotePeer, info);
                    void this.acknowledgeProgress(remotePeer, info);
                    void this.notifyProgress(remotePeer);
                    Logger(
                        `P2P Replication from ${remotePeer}\n${info.lastSeq} / ${info.maxSeqInBatch})`,
                        logLevel,
                        "p2p-replicator"
                    );
                },
                { live: false, rewind: fromStart, signal /*, batch_size: batchSize */ }
            );
            Logger(`P2P replicateFrom replicateShim returned for ${remotePeer}`, LOG_LEVEL_VERBOSE, "p2p-replicator");
            void this.acknowledgeProgress(remotePeer, undefined);
            if (outcome.status === "cancelled") {
                Logger(`P2P Replication from ${remotePeer} has been cancelled`, logLevel, "p2p-replicator");
                return P2P_REPLICATION_CANCELLED;
            }
            Logger(`P2P Replication from ${remotePeer} has been completed`, logLevel, "p2p-replicator");
        } catch (e) {
            if (signal?.aborted) return P2P_REPLICATION_CANCELLED;
            Logger("Error while P2P replicating", logLevel, "p2p-replicator");
            Logger(e, LOG_LEVEL_VERBOSE);
            return p2pReplicationFailed(e);
        } finally {
            this._replicateFromPeers.delete(remotePeer);
            this.dispatchStatus();
        }
        return P2P_REPLICATION_COMPLETED;
    }
    notifyProgress(excludePeerId?: string) {
        if (!this._isBroadcasting) return;
        if (!this.server) return;
        for (const peer of this.server.knownAdvertisements) {
            const peerId = peer.peerId;
            if (peerId === excludePeerId) continue;
            void serialized(`notifyProgress-${peerId}`, async () => {
                const isAcceptable = await this.server?.isAcceptablePeer(peerId);
                // Logger(`Checking peer ${peerId} for progress notification`, LOG_LEVEL_VERBOSE);
                if (isAcceptable) {
                    try {
                        const ret = await this.server
                            ?.getConnection(peerId)
                            .invokeRemoteFunction("onProgress", [this.server?.serverPeerId], 0);
                        return ret;
                    } catch (e) {
                        Logger(`Error while notifying progress to ${peerId}`, LOG_LEVEL_VERBOSE);
                        Logger(e, LOG_LEVEL_VERBOSE);
                    }
                } else {
                    Logger(`Peer ${peerId} is not acceptable to notify progress`, LOG_LEVEL_VERBOSE);
                }
            });
        }
        return Promise.resolve();
    }
    async requestBroadcastChanges(peerId: string) {
        return await this.server
            ?.getConnection(peerId)
            .invokeRemoteFunction("requestBroadcasting", [this.server.serverPeerId], 0);
    }
    async getRemoteIsBroadcasting(peerId: string) {
        try {
            return await this.server?.getConnection(peerId).invokeRemoteFunction("getIsBroadcasting", [], 0);
        } catch (e) {
            Logger("Error while getting remote is broadcasting", LOG_LEVEL_VERBOSE);
            Logger(e, LOG_LEVEL_VERBOSE);
        }
    }
    _watchingPeers = new Set<string>();

    watchPeer(peerId: string) {
        this._watchingPeers.add(peerId);
        this.dispatchStatus();
    }
    unwatchPeer(peerId: string) {
        this._watchingPeers.delete(peerId);
        this.dispatchStatus();
    }

    async onUpdateDatabase(fromPeerId: string) {
        if (this._watchingPeers.has(fromPeerId)) {
            Logger(`Progress notification from ${fromPeerId}`, LOG_LEVEL_VERBOSE);
            return await serialized(`onProgress-${fromPeerId}`, async () => {
                return await this.runFiniteReplicationActivity(() => this.replicateFrom(fromPeerId));
            });
        }
        return false;
    }
    async getRemoteConfig(peerId: string) {
        if (!this.server) {
            Logger("Server is not available", LOG_LEVEL_NOTICE);
            return false;
        }
        const connection = this.server.getConnection(peerId);
        const encryptedConfig = await connection.invokeRemoteFunction("getAllConfig", [this.server.serverPeerId], 0);
        const passphrase = await this.confirm.askString(
            "Passphrase required",
            this.translate("P2P.AskPassphraseForDecrypt"),
            "something you only know",
            true
        );
        if (!passphrase || passphrase.trim() == "") {
            Logger(
                "Passphrase is required to decrypt the configuration. The config cannot be decrypted",
                LOG_LEVEL_NOTICE
            );
            return false;
        }
        try {
            const decryptedConfig = JSON.parse(
                await decrypt(encryptedConfig as string, passphrase)
            ) as ObsidianLiveSyncSettings;
            return decryptedConfig;
        } catch (e) {
            Logger("Error while decrypting the configuration", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    async checkTweakValues(peerId: string, signal?: AbortSignal) {
        if (!this.server) {
            Logger("Server is not available", LOG_LEVEL_NOTICE);
            return false;
        }
        const peerPlatform = this.server.knownAdvertisements.find((e) => e.peerId == peerId)?.platform;
        if (peerPlatform == null) {
            Logger("Peer is not found", LOG_LEVEL_NOTICE);
            return false;
        }
        if (this.platform === "pseudo-replicator") {
            return true;
        }
        if (peerPlatform === "pseudo-replicator") {
            return true;
        }

        const connection = this.server.getConnection(peerId);
        const tweakValues = await connection.invokeRemoteObjectFunction<
            ReturnType<typeof this.getCommands>,
            "getTweakSettings"
        >("getTweakSettings", [this.server.serverPeerId], 5000, signal);
        if (signal?.aborted) return false;
        const thisTweakValues = await this.getTweakSettings("");
        if (!isObjectDifferent(thisTweakValues, tweakValues)) {
            return true;
        }

        if (thisTweakValues.passphrase !== tweakValues.passphrase) {
            Logger(
                "Replication cancelled: Passphrase is not matched\nCannot replicate to a remote database until the problem is resolved.",
                LOG_LEVEL_NOTICE
            );
            return false;
        }

        Logger(
            "Some mismatched configuration have been detected... Please check settings for efficient replication.",
            LOG_LEVEL_NOTICE
        );
        return true;
    }

    private configuredPeerNames(): string[] {
        return [...new Set(this._env.settings.P2P_SyncOnReplication.split(",").map((name) => name.trim()))].filter(
            Boolean
        );
    }

    private findAdvertisement(peerName: string): Advertisement | undefined {
        return this.knownAdvertisements.find((advertisement) => advertisement.name === peerName);
    }

    private async waitForConfiguredAdvertisements(
        peerNames: readonly string[],
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<void> {
        const allPresent = () => peerNames.every((name) => this.findAdvertisement(name) !== undefined);
        if (allPresent() || timeoutMs <= 0 || signal?.aborted) return;

        await new Promise<void>((resolve) => {
            let timeout: CompatTimeoutHandle | undefined;
            let detachAdvertisement = (): void => undefined;
            const finish = () => {
                detachAdvertisement();
                signal?.removeEventListener("abort", finish);
                if (timeout !== undefined) compatGlobal.clearTimeout(timeout);
                resolve();
            };
            detachAdvertisement = this._env.events.onEvent(EVENT_ADVERTISEMENT_RECEIVED, () => {
                if (allPresent()) finish();
            });
            signal?.addEventListener("abort", finish, { once: true });
            timeout = compatGlobal.setTimeout(finish, timeoutMs);
            if (allPresent() || signal?.aborted) finish();
        });
    }

    private configuredTargetResult(
        name: string,
        peerId: string,
        result: P2PReplicationResult
    ): P2PConfiguredTargetResult {
        if (result.status === "completed") return { name, peerId, status: "completed" };
        if (result.status === "cancelled") return { name, peerId, status: "cancelled" };
        return { name, peerId, status: "failed", error: result.error };
    }

    /** Synchronise configured peer targets without opening peer-selection UI. */
    async replicateFromCommand(
        showResult: boolean = false,
        discoveryTimeoutMs: number = 5000,
        callerSignal?: AbortSignal
    ): Promise<P2PConfiguredReplicationResult> {
        const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        if (!this._env.settings.P2P_Enabled) {
            Logger(this.translate("P2P.NotEnabled"), logLevel);
            return { status: "blocked", reason: "no-targets", targets: [] };
        }
        const peerNames = this.configuredPeerNames();
        if (peerNames.length === 0) {
            Logger(this.translate("P2P.NoAutoSyncPeers"), LOG_LEVEL_NOTICE);
            return { status: "blocked", reason: "no-targets", targets: [] };
        }

        await this.waitForConfiguredAdvertisements(peerNames, discoveryTimeoutMs, callerSignal);
        const targets: P2PConfiguredTargetResult[] = [];
        for (const peerName of peerNames) {
            if (callerSignal?.aborted) {
                targets.push({ name: peerName, status: "cancelled" });
                continue;
            }
            const advertisement = this.findAdvertisement(peerName);
            if (!advertisement) {
                Logger(this.translate(`P2P.SeemsOffline`, { name: peerName }), logLevel);
                targets.push({ name: peerName, status: "missing" });
                continue;
            }

            const acceptance: P2PPeerAcceptance =
                (await this.server?.evaluatePeerAcceptance(advertisement.peerId)) ?? "unknown";
            if (acceptance !== "accepted") {
                targets.push({
                    name: peerName,
                    peerId: advertisement.peerId,
                    status: acceptance === "rejected" ? "rejected" : acceptance === "undecided" ? "undecided" : "missing",
                });
                continue;
            }

            Logger(this.translate(`P2P.SyncStartedWith`, { name: peerName }), logLevel);
            const result = await this.automationCoordinator.runBaseline(peerName, () =>
                this.sync(advertisement.peerId, showResult, callerSignal)
            );
            targets.push(this.configuredTargetResult(peerName, advertisement.peerId, result));
        }

        if (targets.every((target) => target.status === "completed")) {
            Logger(this.translate("P2P.SyncCompleted"), logLevel);
            return { status: "completed", targets };
        }
        if (targets.every((target) => target.status === "cancelled")) {
            return { status: "cancelled", targets };
        }
        return { status: "partial", targets };
    }

    disconnectFromServer() {
        // Trystero does not provide typings for getRelaySockets.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        const connections = getRelaySockets() as Record<string, { close: () => void }>;
        const sockets = Object.entries(connections);
        pauseRelayReconnection();
        sockets.forEach(([, s]) => {
            s.close();
        });
        void this.pauseServe();
    }
    async pauseServe() {
        await this.server?.close();
        await this.server?.dispatchConnectionStatus();
    }
    allowReconnection() {
        resumeRelayReconnection();
    }
}
