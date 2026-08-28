import { Logger } from "@lib/common/logger";
import {
    type RemoteDBSettings,
    type EntryLeaf,
    type TweakValues,
    type RemotePreferredTweakResult,
    RemotePreferredTweakStatuses,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_INFO,
    LOG_LEVEL_VERBOSE,
    type LOG_LEVEL,
    type NodeData,
} from "@lib/common/types";
import {
    LiveSyncAbstractReplicator,
    type LiveSyncReplicatorEnv,
    type RemoteDBStatus,
} from "@lib/replication/LiveSyncAbstractReplicator";
import { TrysteroReplicator } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_CONNECTED,
    type AcceptanceDecision,
    type RevokeAcceptanceDecision,
} from "./TrysteroReplicatorP2PServer";
import { delay } from "octagonal-wheels/promises";
import type { Advertisement } from "./types";
import { P2PRoomSessionOwner, type P2PRoomSessionAccess } from "./P2PRoomSessionOwner";

export interface LiveSyncTrysteroReplicatorEnv extends LiveSyncReplicatorEnv {
    // services: IServiceHub;
    /**
     * Injected by the host platform (e.g. Obsidian) to show a UI for peer selection.
     * When not set, openReplication falls back to replicateFromCommand (CLI-safe).
     */
    openReplicationUI?: (showResult: boolean) => Promise<boolean | void>;
    /**
     * Injected by the host platform to show a UI for selecting a peer to rebuild from.
     * When not set, replicateAllFromServer falls back to the headless selectPeer dialog.
     */
    openRebuildUI?: (showResult: boolean) => Promise<boolean | void>;
}

export class LiveSyncTrysteroReplicator extends LiveSyncAbstractReplicator {
    /** Peer lifecycle is fenced inside the room session rather than this facade. */
    readonly handlesPeerEventsWithinSession = true;

    get openReplicationUI() {
        return this.env.openReplicationUI;
    }

    get rawReplicator() {
        return this.sessionOwner.currentSession?.replicator;
    }
    get rawHost() {
        return this.sessionOwner.currentSession?.host;
    }

    getReplicationPBKDF2Salt(_setting: RemoteDBSettings, _refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        return Promise.resolve(new Uint8Array(32));
    }

    terminateSync(): void {
        this.sessionOwner.cancelActiveTransfers();
    }

    async open() {
        await this.sessionOwner.open();
    }

    async close() {
        await this.sessionOwner.close();
    }

    closeReplication(): void {
        this.sessionOwner.currentSession?.replicator.disconnectFromServer();
    }

    get server() {
        return this.sessionOwner.currentSession?.replicator.server;
    }

    get knownAdvertisements() {
        return this.sessionOwner.currentSession?.replicator.knownAdvertisements ?? [];
    }

    enableBroadcastChanges() {
        this.sessionOwner.currentSession?.replicator.enableBroadcastChanges();
    }

    disableBroadcastChanges() {
        this.sessionOwner.currentSession?.replicator.disableBroadcastChanges();
    }

    requestStatus() {
        this.sessionOwner.currentSession?.replicator.requestStatus();
    }

    onNewPeer(peer: Advertisement) {
        return this.sessionOwner.currentSession?.replicator.onNewPeer(peer);
    }

    onPeerLeaved(peerId: string) {
        this.sessionOwner.currentSession?.replicator.onPeerLeaved(peerId);
    }

    async replicateFromCommand(showResult: boolean = false) {
        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) return false;
        const result = await this.env.services.replicator.runFiniteReplicationActivity(
            () => replicator.replicateFromCommand(showResult),
            { label: "replication" }
        );
        return result.status === "completed";
    }

    async replicateFrom(peerId: string, showNotice: boolean = false, skipOrdinaryReplicationPolicy = false) {
        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await this.env.services.replicator.runFiniteReplicationActivity(
            () =>
                skipOrdinaryReplicationPolicy
                    ? replicator.replicateFrom(peerId, showNotice, false, true)
                    : replicator.replicateFrom(peerId, showNotice),
            { label: "replication" }
        );
    }

    async requestSynchroniseToPeer(peerId: string) {
        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await this.env.services.replicator.runBoundedRemoteActivity(
            () => replicator.requestSynchroniseToPeer(peerId),
            { label: "replication" }
        );
    }

    async getRemoteConfig(peerId: string) {
        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await replicator.getRemoteConfig(peerId);
    }

    watchPeer(peerId: string) {
        this.sessionOwner.currentSession?.replicator.watchPeer(peerId);
    }

    unwatchPeer(peerId: string) {
        this.sessionOwner.currentSession?.replicator.unwatchPeer(peerId);
    }

    async sync(peerId: string, showNotice: boolean = false) {
        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await replicator.sync(peerId, showNotice);
    }

    setOnSetup() {
        this.sessionOwner.currentSession?.replicator.setOnSetup();
    }

    clearOnSetup() {
        this.sessionOwner.currentSession?.replicator.clearOnSetup();
    }

    async makeDecision(decision: AcceptanceDecision) {
        await this.sessionOwner.currentSession?.replicator.server?.makeDecision(decision);
    }

    async revokeDecision(decision: RevokeAcceptanceDecision) {
        await this.sessionOwner.currentSession?.replicator.server?.revokeDecision(decision);
    }

    async makeSureOpened() {
        if (!this.sessionOwner.isConnected) {
            await this.open();
        }
    }

    async openReplication(
        _setting: RemoteDBSettings,
        _keepAlive: boolean,
        showResult: boolean,
        _ignoreCleanLock: boolean
    ): Promise<void | boolean> {
        // If a UI handler was injected (e.g. Obsidian modal), use it.
        if (this.openReplicationUI) {
            return this.openReplicationUI(showResult);
        }
        // Fallback: CLI or headless environment — run non-interactive replication.
        const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;

        await this.makeSureOpened();
        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) {
            Logger(this.translate("P2P.ReplicatorInstanceMissing"), logLevel);
            return false;
        }
        const result = await replicator.replicateFromCommand(showResult);
        return result.status === "completed";
    }

    tryConnectRemote(_setting: RemoteDBSettings, _showResult?: boolean): Promise<boolean> {
        return Promise.resolve(false);
    }

    replicateAllToServer(_setting: RemoteDBSettings, _showingNotice?: boolean): Promise<boolean> {
        return Promise.resolve(false);
    }

    async selectPeer(settingPeerName: string, r: TrysteroReplicator, logLevel: LOG_LEVEL): Promise<string | false> {
        const knownPeersOrg = r.server?.knownAdvertisements ?? [];
        let knownPeers: typeof knownPeersOrg;
        if (knownPeersOrg.length != 0) {
            knownPeers = knownPeersOrg;
        } else {
            Logger(this.translate("P2P.NoKnownPeers"), logLevel);
            await Promise.race([delay(5000), this.env.services.context.events.waitFor(EVENT_ADVERTISEMENT_RECEIVED)]);
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
            await Promise.race([delay(1000), this.env.services.context.events.waitFor(EVENT_ADVERTISEMENT_RECEIVED)]);
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
            return Promise.reject(new Error("Cannot find confirm instance."));
        }
        let result;
        while (!result) {
            for (let i = 0; i < repeat; i++) {
                try {
                    result = await func();
                    if (result) break;
                } catch (e) {
                    Logger(`Error: ${e instanceof Error ? e.message : String(e)}`, logLevel);
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
            if ((await confirm.askYesNoDialog(this.translate("P2P.DisabledButNeed"), {})) != "yes") {
                Logger(this.translate("P2P.NotEnabled"), logLevel);
            }
            setting.P2P_Enabled = true;
            this.env.services.setting.currentSettings().P2P_Enabled = true;
            await this.env.services.setting.saveSettingData();
            await delay(100);
            return this.replicateAllFromServer(setting, showingNotice);
        }
        await this.open();

        const replicator = this.sessionOwner.currentSession?.replicator;
        if (!replicator) {
            Logger("Failed to get replicator instance.", logLevel);
            return false;
        }

        // If a rebuild UI handler was injected (e.g. Obsidian modal), use it.
        if (this.env.openRebuildUI) {
            return (await this.env.openRebuildUI(showingNotice ?? false)) !== false;
        }

        // Fallback: headless peer-selection flow (CLI / non-Obsidian).
        await this.env.services.context.events.waitFor(EVENT_P2P_CONNECTED);
        const peerFrom = setting.P2P_RebuildFrom;
        replicator.setOnSetup();
        try {
            const r = await this.tryUntilSuccess(
                async () => {
                    await this.makeSureOpened();
                    return this.sessionOwner.currentSession?.replicator ?? false;
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
            const rep = await r.replicateFrom(peerId, showingNotice, false, true);
            if (rep.ok) {
                Logger("P2P Fetching has been succeed from " + peerId + ".", logLevel);
                return true;
            } else {
                Logger("Failed to fetch from peer " + peerId + ".", logLevel);
                Logger(rep.error, LOG_LEVEL_VERBOSE);
                return false;
            }
        } finally {
            this.sessionOwner.currentSession?.replicator.clearOnSetup();
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
    getRemotePreferredTweakValues(_setting: RemoteDBSettings): Promise<RemotePreferredTweakResult> {
        Logger(
            "Trying to get tweak values but P2P replication does not support to do this. This operation has been ignored",
            LOG_LEVEL_INFO
        );
        return Promise.resolve({ status: RemotePreferredTweakStatuses.UNSUPPORTED });
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

    declare env: LiveSyncTrysteroReplicatorEnv;
    constructor(
        env: LiveSyncTrysteroReplicatorEnv,
        private readonly sessionOwner: P2PRoomSessionAccess = new P2PRoomSessionOwner(env)
    ) {
        super(env);
        this.env = env;
    }
}
