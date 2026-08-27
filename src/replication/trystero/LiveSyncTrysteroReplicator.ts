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
    SETTING_KEY_P2P_DEVICE_NAME,
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
import type { AsyncActivityOptions } from "@lib/interfaces/AsyncActivityRunner";

import type { Advertisement } from "./types";
import {
    hasValidP2PTurnServerUrl,
    normaliseP2PConnectionPath,
    normaliseP2PMaxWirePayloadBytes,
} from "@lib/common/models/setting.p2p";
import { P2PConnectionPaths } from "@lib/common/models/setting.const";
import { P2PRoomSession } from "./P2PRoomSession";

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
    private _roomSession?: P2PRoomSession;
    private _lifecycleOperation: Promise<void> = Promise.resolve();
    private _shouldBeOpen = false;
    private _activeTransportCompatibilitySignature?: string;

    get openReplicationUI() {
        return this.env.openReplicationUI;
    }

    get rawReplicator() {
        return this._roomSession?.replicator;
    }
    get rawHost() {
        return this._roomSession?.host;
    }

    getReplicationPBKDF2Salt(_setting: RemoteDBSettings, _refresh?: boolean): Promise<Uint8Array<ArrayBuffer>> {
        return Promise.resolve(new Uint8Array(32));
    }

    terminateSync(): void {
        this._roomSession?.cancelActiveTransfers();
    }

    private _buildEnv() {
        const services = this.env.services;
        return {
            events: services.context.events,
            translate: services.context.translate,
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
            runFiniteReplicationActivity: <T>(task: () => T | PromiseLike<T>, options?: AsyncActivityOptions) =>
                services.replicator.runFiniteReplicationActivity(task, options),
            canStartOrdinaryReplication: (showMessage: boolean = false) =>
                services.replication.onCheckReplicationReady(showMessage),
            processReplicatedDocs: async (docs: Parameters<typeof services.replication.parseSynchroniseResult>[0]) => {
                const settings = services.setting.currentSettings();
                if (settings.suspendParseReplicationResult) {
                    const docLength = docs.length;
                    if (docLength > 0) {
                        Logger(
                            `P2P sync, but parseReplicationResult is suspended. Ignoring ${docLength} documents.`,
                            LOG_LEVEL_VERBOSE
                        );
                    }
                    return;
                }
                await services.replication.parseSynchroniseResult(docs);
            },
        };
    }

    private _enqueueLifecycleOperation(operation: () => Promise<void>): Promise<void> {
        const queued = this._lifecycleOperation.catch((): void => undefined).then(operation);
        this._lifecycleOperation = queued.catch((): void => undefined);
        return queued;
    }

    /**
     * Capture settings which are fixed when the active P2P transport joins its room.
     * A later open request can remain idempotent only while these effective values match.
     */
    private _getTransportCompatibilitySignature(): string {
        const settings = this.env.services.setting.currentSettings();
        const configuredPath = normaliseP2PConnectionPath(settings.P2P_connectionPath);
        const effectivePath =
            configuredPath === P2PConnectionPaths.Relay && hasValidP2PTurnServerUrl(settings.P2P_turnServers ?? "")
                ? P2PConnectionPaths.Relay
                : P2PConnectionPaths.Automatic;
        return `${normaliseP2PMaxWirePayloadBytes(settings.P2P_maxWirePayloadBytes)}:${effectivePath}`;
    }

    /** Close and forget the transport without changing the requested lifecycle state. */
    private async _closeTransport(): Promise<void> {
        const session = this._roomSession;
        this._roomSession = undefined;
        if (session) {
            await session.retire();
        }
        this._activeTransportCompatibilitySignature = undefined;
    }

    async open() {
        if (!this.env.services.setting.currentSettings().P2P_Enabled) {
            Logger(this.translate("P2P.NotEnabled"), LOG_LEVEL_NOTICE);
            // Nothing to do.
            return;
        }
        this._shouldBeOpen = true;
        await this._enqueueLifecycleOperation(async () => {
            if (!this._shouldBeOpen) return;
            const compatibilitySignature = this._getTransportCompatibilitySignature();
            if (this._roomSession?.host.isServing) {
                if (this._activeTransportCompatibilitySignature === compatibilitySignature) {
                    Logger("P2P replicator is already open.");
                    return;
                }
                await this._closeTransport();
            }
            let candidate: P2PRoomSession | undefined;
            try {
                const env = this._buildEnv();
                candidate = new P2PRoomSession(env);
                await candidate.open();
                this._roomSession = candidate;
                this._activeTransportCompatibilitySignature = compatibilitySignature;
            } catch (e) {
                await candidate?.retire(e).catch((retirementError: unknown) => {
                    Logger(retirementError, LOG_LEVEL_VERBOSE);
                });
                Logger(e instanceof Error ? e.message : "Error while opening P2P connection", LOG_LEVEL_NOTICE);
                Logger(e, LOG_LEVEL_VERBOSE);
                this._roomSession = undefined;
                this._activeTransportCompatibilitySignature = undefined;
            }
        });
    }

    async close() {
        this._shouldBeOpen = false;
        await this._enqueueLifecycleOperation(async () => {
            await this._closeTransport();
        });
    }

    closeReplication(): void {
        this._roomSession?.replicator.disconnectFromServer();
    }

    get server() {
        return this._roomSession?.replicator.server;
    }

    get knownAdvertisements() {
        return this._roomSession?.replicator.knownAdvertisements ?? [];
    }

    enableBroadcastChanges() {
        this._roomSession?.replicator.enableBroadcastChanges();
    }

    disableBroadcastChanges() {
        this._roomSession?.replicator.disableBroadcastChanges();
    }

    requestStatus() {
        this._roomSession?.replicator.requestStatus();
    }

    onNewPeer(peer: Advertisement) {
        return this._roomSession?.replicator.onNewPeer(peer);
    }

    onPeerLeaved(peerId: string) {
        this._roomSession?.replicator.onPeerLeaved(peerId);
    }

    async replicateFromCommand(showResult: boolean = false) {
        const replicator = this._roomSession?.replicator;
        if (!replicator) return;
        await this.env.services.replicator.runFiniteReplicationActivity(
            () => replicator.replicateFromCommand(showResult),
            { label: "replication" }
        );
    }

    async replicateFrom(peerId: string, showNotice: boolean = false, skipOrdinaryReplicationPolicy = false) {
        const replicator = this._roomSession?.replicator;
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
        const replicator = this._roomSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await this.env.services.replicator.runBoundedRemoteActivity(
            () => replicator.requestSynchroniseToPeer(peerId),
            { label: "replication" }
        );
    }

    async getRemoteConfig(peerId: string) {
        const replicator = this._roomSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await replicator.getRemoteConfig(peerId);
    }

    watchPeer(peerId: string) {
        this._roomSession?.replicator.watchPeer(peerId);
    }

    unwatchPeer(peerId: string) {
        this._roomSession?.replicator.unwatchPeer(peerId);
    }

    async sync(peerId: string, showNotice: boolean = false) {
        const replicator = this._roomSession?.replicator;
        if (!replicator) throw new Error("P2P replicator is not open");
        return await replicator.sync(peerId, showNotice);
    }

    setOnSetup() {
        this._roomSession?.replicator.setOnSetup();
    }

    clearOnSetup() {
        this._roomSession?.replicator.clearOnSetup();
    }

    async makeDecision(decision: AcceptanceDecision) {
        await this._roomSession?.replicator.server?.makeDecision(decision);
    }

    async revokeDecision(decision: RevokeAcceptanceDecision) {
        await this._roomSession?.replicator.server?.revokeDecision(decision);
    }

    async makeSureOpened() {
        if (!this._roomSession?.host.isServing) {
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
        const replicator = this._roomSession?.replicator;
        if (!replicator) {
            Logger(this.translate("P2P.ReplicatorInstanceMissing"), logLevel);
            return false;
        }
        await replicator.replicateFromCommand(showResult);
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

        const replicator = this._roomSession?.replicator;
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
                    return this._roomSession?.replicator ?? false;
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
            this._roomSession?.replicator.clearOnSetup();
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
    constructor(env: LiveSyncTrysteroReplicatorEnv) {
        super(env);
        this.env = env;
    }
}
