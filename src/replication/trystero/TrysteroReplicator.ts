import { TweakValuesShouldMatchedTemplate, type EntryDoc, type ObsidianLiveSyncSettings } from "../../common/types";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE, Logger } from "octagonal-wheels/common/logger";
import { replicateShim, type PouchDBShim, type ProgressInfo } from "../../pouchdb/ReplicatorShim";
import type { Confirm } from "../../interfaces/Confirm";
import { type Advertisement, type ReplicatorHostEnv } from "./types";
import { TrysteroConnection } from "./TrysteroReplicatorP2PConnection";
import { scheduleOnceIfDuplicated, serialized, skipIfDuplicated } from "octagonal-wheels/concurrency/lock_v2";
import { delay, fireAndForget } from "octagonal-wheels/promises";
import {
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_P2P_REPLICATOR_STATUS,
    type TrysteroReplicatorP2PServer,
} from "./TrysteroReplicatorP2PServer";
import { eventHub } from "../../hub/hub";
import { decrypt, encrypt } from "octagonal-wheels/encryption";
import { $msg } from "../../common/i18n";
import { sha1 } from "octagonal-wheels/hash/purejs";
import { isObjectDifferent } from "octagonal-wheels/object";
import { getRelaySockets, pauseReconnection, resumeReconnection } from "trystero/nostr";

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

    server?: TrysteroReplicatorP2PServer;
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

    constructor(env: ReplicatorHostEnv) {
        this._env = env;
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
            this.server = new TrysteroConnection(env);
        } catch (e) {
            Logger(e instanceof Error ? e.message : "Error while creating TrysteroReplicator", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            throw e;
        }
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

    async open() {
        this.allowReconnection();
        await this.server?.start([this.getCommands()]);
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
        if (this.autoSyncPeers.some((e) => e.test(peerName))) {
            await this.sync(peer.peerId);
        }
        if (this.autoWatchPeers.some((e) => e.test(peerName))) {
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

    getCommands() {
        return {
            reqSync: async (fromPeerId: string) => {
                if (this._onSetup) {
                    return { error: new Error("The setup is in progress") };
                }
                return await this.replicateFrom(fromPeerId);
            },
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
                        $msg("P2P.AskPassphraseForShare"),
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
                    return encrypt(r, randomString, false);
                }
                return encrypt(JSON.stringify(setting), passphrase.trim(), false);
            },
            onProgressAcknowledged: async (fromPeerId: string, info: ProgressInfo) => {
                try {
                    await this.onProgressAcknowledged(fromPeerId, info);
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

    async requestAuthenticate(peerId: string) {
        if (!this.server) return false;
        try {
            const connection = this.server.getConnection(peerId);
            const selfPeerId = this.server.serverPeerId;
            const r = await connection.invokeRemoteObjectFunction<ReturnType<typeof this.getCommands>, "!reqAuth">(
                "!reqAuth",
                [selfPeerId],
                20000
            );
            return r;
        } catch (e) {
            Logger("Error while requesting authentication", LOG_LEVEL_VERBOSE);
            Logger(e, LOG_LEVEL_VERBOSE);
            return false;
        }
    }

    async selectPeer() {
        if (!this.server) return false;
        const knownPeers = this.server.knownAdvertisements;
        if (knownPeers.length === 0) {
            Logger("No known peers", LOG_LEVEL_VERBOSE);
            return false;
        }

        const peers = [...Object.entries(knownPeers)].map(([peerId, info]) => {
            return `${info.peerId}\u2001: (${info.name})`;
        });

        const selectedPeer = await this.confirm.askSelectString("Select a peer to replicate", peers);
        if (selectedPeer) return selectedPeer.split("\u2001")[0];
        return false;
    }

    lastSeq = "" as string | number;
    async requestSynchroniseToPeer(
        peerId: string
    ): Promise<ReturnType<ReturnType<typeof this.getCommands>["reqSync"]>> {
        await delay(25);
        if (!this.server) throw new Error("Server is not available");
        const conn = this.server.getConnection(peerId);
        return await conn.invokeRemoteFunction("reqSync", [this.server.serverPeerId], 0);
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
        eventHub.emitEvent(EVENT_P2P_REPLICATOR_STATUS, {
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
        const closeChanges = (reason: any) => {
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

    async sync(remotePeer: string, showNotice: boolean = false) {
        const from = await this.replicateFrom(remotePeer, showNotice);
        if (!from || from.error) {
            Logger("Error while replicating from the remote", LOG_LEVEL_VERBOSE);
            Logger(from.error, LOG_LEVEL_VERBOSE);
            return from;
        }
        const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        Logger(`P2P Replication has been requested to ${remotePeer}`, logLevel, "p2p-replicator");

        const res = await this.requestSynchroniseToPeer(remotePeer);
        if (res.ok) {
            Logger("P2P Replication has been done", logLevel, "p2p-replicator");
        }
        if (res.error) {
            Logger("Error while syncing from the remote", logLevel, "p2p-replicator");
            Logger(res.error, LOG_LEVEL_VERBOSE);
        }
    }

    _replicateToPeers = new Set<string>();
    async replicateTo() {
        await this.makeSureOpened();
        const remotePeer = await this.selectPeer();
        if (!remotePeer) {
            Logger("No peer selected", LOG_LEVEL_VERBOSE);
            return;
        }
        Logger(`P2P Replicating to ${remotePeer}`, LOG_LEVEL_INFO);
        try {
            if (this._replicateToPeers.has(remotePeer)) {
                Logger(`Replication to ${remotePeer} is already in progress`, LOG_LEVEL_VERBOSE);
                return;
            }
            this._replicateToPeers.add(remotePeer);
            this.dispatchStatus();
            return await this.requestSynchroniseToPeer(remotePeer);
        } finally {
            this._replicateToPeers.delete(remotePeer);
            this.dispatchStatus();
        }
    }

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
        eventHub.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, stat);
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
        eventHub.emitEvent(EVENT_P2P_REPLICATOR_PROGRESS, ack);
        return true;
    }
    // Sending the progress to the remote peer
    acknowledgeProgress(remotePeerId: string, info?: ProgressInfo) {
        if (!this.server) return;
        const connection = this.server.getConnection(remotePeerId);
        try {
            void connection.invokeRemoteFunction("onProgressAcknowledged", [this.server.serverPeerId, info], 500);
        } catch (ex) {
            Logger("Error while acknowledging the progress", LOG_LEVEL_VERBOSE);
            Logger(ex, LOG_LEVEL_VERBOSE);
        }
    }
    async replicateFrom(remotePeer: string, showNotice: boolean = false, fromStart = false) {
        const logLevel = showNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        Logger(`P2P Requesting Authentication to ${remotePeer}`, logLevel, "p2p-replicator");
        if ((await this.requestAuthenticate(remotePeer)) !== true) {
            Logger("Peer rejected the connection", LOG_LEVEL_NOTICE, "p2p-replicator");
            return { error: new Error("Peer rejected the connection") };
        }

        if ((await this.checkTweakValues(remotePeer)) !== true) {
            Logger("Tweak values are not matched", LOG_LEVEL_NOTICE, "p2p-replicator");
            return { error: new Error("Tweak values are not matched") };
        }

        Logger(`P2P Replicating from ${remotePeer}`, logLevel, "p2p-replicator");
        if (this._replicateFromPeers.has(remotePeer)) {
            Logger(`Replication from ${remotePeer} is already in progress`, LOG_LEVEL_NOTICE, "p2p-replicator");
            return { error: new Error("Replication from this peer is already in progress") };
        }
        this._replicateFromPeers.add(remotePeer);
        this.dispatchStatus();

        try {
            if (!this.server) {
                throw new Error("Server is not available");
            }
            const connection = this.server.getConnection(remotePeer);
            const remoteDB = connection.remoteDB;
            await replicateShim(
                this.db,
                remoteDB as PouchDBShim<any>,
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
                { live: false, rewind: fromStart }
            );
            void this.acknowledgeProgress(remotePeer, undefined);
            Logger(`P2P Replication from ${remotePeer} has been completed`, logLevel, "p2p-replicator");
        } catch (e) {
            Logger("Error while P2P replicating", logLevel, "p2p-replicator");
            Logger(e, LOG_LEVEL_VERBOSE);
            return { error: e };
        } finally {
            this._replicateFromPeers.delete(remotePeer);
            this.dispatchStatus();
        }
        return { ok: true };
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
                return await this.replicateFrom(fromPeerId);
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
            $msg("P2P.AskPassphraseForDecrypt"),
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
                await decrypt(encryptedConfig as string, passphrase, false)
            ) as ObsidianLiveSyncSettings;
            return decryptedConfig;
        } catch (e) {
            Logger("Error while decrypting the configuration", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            return false;
        }
    }
    async checkTweakValues(peerId: string) {
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
        >("getTweakSettings", [this.server.serverPeerId], 5000);
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

    async replicateFromCommand(showResult: boolean = false) {
        const r = await skipIfDuplicated("replicateFromCommand", async () => {
            const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
            if (!this._env.settings.P2P_Enabled) {
                Logger($msg("P2P.NotEnabled"), logLevel);
                return Promise.resolve(false);
            }
            // throw new Error("Method not implemented.");
            const peers = this._env.settings.P2P_SyncOnReplication.split(",")
                .map((e) => e.trim())
                .filter((e) => e);
            if (peers.length == 0) {
                Logger($msg("P2P.NoAutoSyncPeers"), logLevel);
                return Promise.resolve(false);
            }

            for (const peer of peers) {
                const peerId = this.knownAdvertisements.find((e) => e.name == peer)?.peerId;
                if (!peerId) {
                    Logger($msg(`P2P.SeemsOffline`, { name: peer }), logLevel);
                } else {
                    Logger($msg(`P2P.SyncStartedWith`, { name: peer }), logLevel);
                    await this.sync(peerId, showResult);
                }
            }
            Logger($msg("P2P.SyncCompleted"), logLevel);
            return Promise.resolve(true);
        });
        if (r === null) {
            Logger($msg("P2P.SyncAlreadyRunning"), LOG_LEVEL_NOTICE);
        }
    }

    disconnectFromServer() {
        const connections = getRelaySockets();
        const sockets = Object.entries(connections);
        pauseReconnection();
        sockets.forEach(([, s]) => {
            s.close();
        });
    }
    allowReconnection() {
        resumeReconnection();
    }
}
