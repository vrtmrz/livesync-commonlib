import { eventHub } from "../../hub/hub";
import { Logger } from "../../common/logger";
import {
    type RemoteDBSettings,
    type EntryLeaf,
    type TweakValues,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_INFO,
    LOG_LEVEL_VERBOSE,
    type LOG_LEVEL,
    type NodeData,
    SETTING_KEY_P2P_DEVICE_NAME,
} from "../../common/types";
import {
    LiveSyncAbstractReplicator,
    type LiveSyncReplicatorEnv,
    type RemoteDBStatus,
} from "../LiveSyncAbstractReplicator";
import { TrysteroReplicator } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_CONNECTED,
    P2PHost,
    type AcceptanceDecision,
    type RevokeAcceptanceDecision,
} from "./TrysteroReplicatorP2PServer";
import { $msg } from "../../common/i18n";
import { delay } from "octagonal-wheels/promises";
import type { IServiceHub } from "../../services/base/IService";
import type { Advertisement } from "./types";

export interface LiveSyncTrysteroReplicatorEnv extends LiveSyncReplicatorEnv {
    services: IServiceHub;
}

export class LiveSyncTrysteroReplicator extends LiveSyncAbstractReplicator {
    private _p2pHost?: P2PHost;
    private _replicator?: TrysteroReplicator;

    get rawReplicator() {
        return this._replicator;
    }
    get rawHost() {
        return this._p2pHost;
    }
    override get isChunkSendingSupported(): boolean {
        return false;
    }

    getReplicationPBKDF2Salt(_setting: RemoteDBSettings, _refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        return Promise.resolve(new Uint8Array(32));
    }

    terminateSync(): void {
        // no-op for P2P
    }

    private _buildEnv() {
        const services = this.env.services;
        return {
            get settings() {
                return services.setting.currentSettings();
            },
            get db() {
                return services.database.localDatabase.localDatabase;
            },
            get simpleStore() {
                return services.keyValueDB.openSimpleStore("p2p-sync");
            },
            get deviceName() {
                return services.config.getSmallConfig(SETTING_KEY_P2P_DEVICE_NAME) || services.vault.getVaultName();
            },
            get platform() {
                return services.API.getPlatform();
            },
            get confirm() {
                return services.API.confirm;
            },
            processReplicatedDocs: async (docs: any[]) => {
                await services.replication.parseSynchroniseResult(docs as any);
            },
        };
    }

    async open() {
        if (this._replicator && this._p2pHost?.isServing) {
            return;
        }
        if (!this.env.services.setting.currentSettings().P2P_Enabled) {
            // Nothing to do.
            return;
        }
        try {
            const env = this._buildEnv();
            const host = new P2PHost(env as any);
            const replicator = new TrysteroReplicator(env as any, host);
            this._p2pHost = host;
            this._replicator = replicator;
            await replicator.open();
        } catch (e) {
            Logger(e instanceof Error ? e.message : "Error while opening P2P connection", LOG_LEVEL_NOTICE);
            Logger(e, LOG_LEVEL_VERBOSE);
            this._p2pHost = undefined;
            this._replicator = undefined;
        }
    }

    async close() {
        if (this._replicator) {
            this._replicator.disableBroadcastChanges();
            await this._replicator.close();
            this._replicator = undefined;
        }
        this._p2pHost = undefined;
    }

    closeReplication(): void {
        this._replicator?.disconnectFromServer();
    }

    get server() {
        return this._replicator?.server;
    }

    get knownAdvertisements() {
        return this._replicator?.knownAdvertisements ?? [];
    }

    enableBroadcastChanges() {
        this._replicator?.enableBroadcastChanges();
    }

    disableBroadcastChanges() {
        this._replicator?.disableBroadcastChanges();
    }

    requestStatus() {
        this._replicator?.requestStatus();
    }

    onNewPeer(peer: Advertisement) {
        return this._replicator?.onNewPeer(peer);
    }

    onPeerLeaved(peerId: string) {
        this._replicator?.onPeerLeaved(peerId);
    }

    async replicateFromCommand(showResult: boolean = false) {
        await this._replicator?.replicateFromCommand(showResult);
    }

    async replicateFrom(peerId: string, showNotice: boolean = false) {
        if (!this._replicator) throw new Error("P2P replicator is not open");
        return await this._replicator.replicateFrom(peerId, showNotice);
    }

    async requestSynchroniseToPeer(peerId: string) {
        if (!this._replicator) throw new Error("P2P replicator is not open");
        return await this._replicator.requestSynchroniseToPeer(peerId);
    }

    async getRemoteConfig(peerId: string) {
        if (!this._replicator) throw new Error("P2P replicator is not open");
        return await this._replicator.getRemoteConfig(peerId);
    }

    watchPeer(peerId: string) {
        this._replicator?.watchPeer(peerId);
    }

    unwatchPeer(peerId: string) {
        this._replicator?.unwatchPeer(peerId);
    }

    async sync(peerId: string, showNotice: boolean = false) {
        if (!this._replicator) throw new Error("P2P replicator is not open");
        return await this._replicator.sync(peerId, showNotice);
    }

    async makeDecision(decision: AcceptanceDecision) {
        await this._replicator?.server?.makeDecision(decision);
    }

    async revokeDecision(decision: RevokeAcceptanceDecision) {
        await this._replicator?.server?.revokeDecision(decision);
    }

    async makeSureOpened() {
        if (!this._replicator || !this._p2pHost?.isServing) {
            await this.open();
        }
    }

    async openReplication(
        _setting: RemoteDBSettings,
        _keepAlive: boolean,
        showResult: boolean,
        _ignoreCleanLock: boolean
    ): Promise<void | boolean> {
        const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        if (!this._replicator) {
            Logger($msg("P2P.ReplicatorInstanceMissing"), logLevel);
            return false;
        }
        await this._replicator.makeSureOpened();
        await this._replicator.replicateFromCommand(showResult);
    }

    tryConnectRemote(_setting: RemoteDBSettings, _showResult?: boolean): Promise<boolean> {
        return Promise.resolve(false);
    }

    replicateAllToServer(
        _setting: RemoteDBSettings,
        _showingNotice?: boolean,
        _sendChunksInBulkDisabled?: boolean
    ): Promise<boolean> {
        return Promise.resolve(false);
    }

    async selectPeer(settingPeerName: string, r: TrysteroReplicator, logLevel: LOG_LEVEL): Promise<string | false> {
        const knownPeersOrg = r.server?.knownAdvertisements ?? [];
        let knownPeers: typeof knownPeersOrg;
        if (knownPeersOrg.length != 0) {
            knownPeers = knownPeersOrg;
        } else {
            Logger($msg("P2P.NoKnownPeers"), logLevel);
            await Promise.race([delay(5000), eventHub.waitFor(EVENT_ADVERTISEMENT_RECEIVED)]);
            knownPeers = r.server?.knownAdvertisements ?? [];
        }
        const message =
            "Rebuild from which peer?" + (settingPeerName ? "\n [*] indicates the peer you have selected before." : "");
        const confirm = this.env.services.UI.confirm;
        const markedPeerNames = knownPeers.map(
            (e) => e.name + "\u2001" + (e.name == settingPeerName ? "[*]" : "") + " (" + e.peerId + ")"
        );
        const options = [...markedPeerNames, "Refresh List", "Cancel"];
        const selected = await confirm.askSelectStringDialogue(message, options, {
            title: "Select a peer to fetch from",
            defaultAction: "Refresh List",
        });
        if (!selected || selected == "Cancel") {
            return false;
        }
        if (selected == "Refresh List") {
            await Promise.race([delay(1000), eventHub.waitFor(EVENT_ADVERTISEMENT_RECEIVED)]);
            return this.selectPeer(settingPeerName, r, logLevel);
        }
        const selectedPeerName = selected.split("\u2001")[0];
        const peerId = knownPeers.find((e) => e.name == selectedPeerName)?.peerId;
        if (!peerId) {
            Logger("Failed to find peerId for " + selectedPeerName, logLevel);
            return false;
        }
        return peerId;
    }

    async tryUntilSuccess<T>(func: () => Promise<T | false>, repeat: number, logLevel: LOG_LEVEL): Promise<T | false> {
        const confirm = this.env.services.UI.confirm;
        if (!confirm) {
            Logger("Cannot find confirm instance.", logLevel);
            return Promise.reject("Cannot find confirm instance.");
        }
        let result;
        while (!result) {
            for (let i = 0; i < repeat; i++) {
                try {
                    result = await func();
                    if (result) break;
                } catch (e) {
                    Logger("Error: " + e, logLevel);
                    result = false;
                }
                await delay(1000);
            }
        }
        return result as T;
    }

    async replicateAllFromServer(setting: RemoteDBSettings, showingNotice?: boolean): Promise<boolean> {
        const logLevel = showingNotice ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        if (setting.P2P_Enabled == false) {
            const confirm = this.env.services.UI.confirm;
            if ((await confirm.askYesNoDialog($msg("P2P.DisabledButNeed"), {})) != "yes") {
                Logger($msg("P2P.NotEnabled"), logLevel);
            }
            setting.P2P_Enabled = true;
            this.env.services.setting.currentSettings().P2P_Enabled = true;
            await this.env.services.setting.saveSettingData();
            await delay(100);
            return this.replicateAllFromServer(setting, showingNotice);
        }
        await this.open();
        await eventHub.waitFor(EVENT_P2P_CONNECTED);

        const peerFrom = setting.P2P_RebuildFrom;
        if (!this._replicator) {
            Logger("Failed to get replicator instance.", logLevel);
            return false;
        }
        this._replicator.setOnSetup();
        try {
            const r = await this.tryUntilSuccess(
                async () => {
                    await this.makeSureOpened();
                    return this._replicator ?? false;
                },
                10,
                logLevel
            );
            if (r === false) {
                Logger("Failed to open P2P connection.", logLevel);
                return false;
            }
            const peerId = await this.selectPeer(peerFrom, r, logLevel);
            if (peerId === false) {
                Logger("Failed to connect peer.", logLevel);
                return false;
            }
            this.env.services.setting.currentSettings().P2P_RebuildFrom = "";
            Logger("Fetching from peer " + peerId + ".", logLevel);
            const rep = await r.replicateFrom(peerId, showingNotice);
            if (rep.ok) {
                Logger("P2P Fetching has been succeed from " + peerId + ".", logLevel);
                return true;
            } else {
                Logger("Failed to fetch from peer " + peerId + ".", logLevel);
                Logger(rep.error, LOG_LEVEL_VERBOSE);
                return false;
            }
        } finally {
            this._replicator?.clearOnSetup();
        }
    }

    tryResetRemoteDatabase(_setting: RemoteDBSettings): Promise<void> {
        throw new Error("P2P replication does not support database reset.");
    }
    tryCreateRemoteDatabase(_setting: RemoteDBSettings): Promise<void> {
        throw new Error("P2P replication does not support database reset.");
    }
    markRemoteLocked(_setting: RemoteDBSettings, _locked: boolean, _lockByClean: boolean): Promise<void> {
        throw new Error("P2P replication does not support database lock.");
    }
    markRemoteResolved(_setting: RemoteDBSettings): Promise<void> {
        Logger(
            "Trying resolving remote-database-lock but P2P replication does not support database lock. This operation has been ignored",
            LOG_LEVEL_INFO
        );
        return Promise.resolve();
    }
    resetRemoteTweakSettings(_setting: RemoteDBSettings): Promise<void> {
        throw new Error("P2P replication does not support resetting tweaks.");
    }
    setPreferredRemoteTweakSettings(_setting: RemoteDBSettings): Promise<void> {
        Logger(
            "Trying setting tweak values but P2P replication does not support to do this. This operation has been ignored",
            LOG_LEVEL_INFO
        );
        return Promise.resolve();
    }
    fetchRemoteChunks(_missingChunks: string[], _showResult: boolean): Promise<false | EntryLeaf[]> {
        return Promise.resolve(false);
    }
    getRemoteStatus(_setting: RemoteDBSettings): Promise<false | RemoteDBStatus> {
        Logger(
            "Trying to get remote status but P2P replication does not support to do this. This operation has been ignored",
            LOG_LEVEL_INFO
        );
        return Promise.resolve(false);
    }
    getRemotePreferredTweakValues(_setting: RemoteDBSettings): Promise<false | TweakValues> {
        Logger(
            "Trying to get tweak values but P2P replication does not support to do this. This operation has been ignored",
            LOG_LEVEL_INFO
        );
        return Promise.resolve(false);
    }
    countCompromisedChunks(): Promise<number> {
        Logger("P2P Replicator cannot count compromised chunks", LOG_LEVEL_VERBOSE);
        return Promise.resolve(0);
    }
    getConnectedDeviceList(
        _setting?: RemoteDBSettings
    ): Promise<false | { node_info: Record<string, NodeData>; accepted_nodes: string[] }> {
        Logger(
            "Trying to get connected device list but P2P replication does not support to do this. This operation has been ignored",
            LOG_LEVEL_INFO
        );
        return Promise.resolve(false);
    }

    override env: LiveSyncTrysteroReplicatorEnv;
    constructor(env: LiveSyncTrysteroReplicatorEnv) {
        super(env);
        this.env = env;
    }
}
