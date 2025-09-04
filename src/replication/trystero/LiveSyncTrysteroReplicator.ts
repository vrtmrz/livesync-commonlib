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
} from "../../common/types";
import {
    LiveSyncAbstractReplicator,
    type LiveSyncReplicatorEnv,
    type RemoteDBStatus,
} from "../LiveSyncAbstractReplicator";
import type { TrysteroReplicator } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_REQUEST_FORCE_OPEN,
} from "./TrysteroReplicatorP2PServer";
import { getConfirmInstance } from "../../PlatformAPIs/obsidian/Confirm";
import { $msg } from "../../common/i18n";
import { delay } from "octagonal-wheels/promises";

// This is under so weird structure. We need to place this in the right place in the near future.

let replicatorInstanceGetter: () => TrysteroReplicator | undefined = () => undefined;

export function getReplicatorInstance() {
    return replicatorInstanceGetter();
}
export function setReplicatorFunc(func: () => TrysteroReplicator | undefined) {
    replicatorInstanceGetter = func;
}

export interface LiveSyncTrysteroReplicatorEnv extends LiveSyncReplicatorEnv {
    $$saveSettingData(): void | Promise<void>;
    settings: RemoteDBSettings;
}

export class LiveSyncTrysteroReplicator extends LiveSyncAbstractReplicator {
    // env: LiveSyncTrysteroReplicatorEnv;

    // NOTE: This is not used for P2P synchronisation. just for the sake of interface compatibility.
    getReplicationPBKDF2Salt(setting: RemoteDBSettings, refresh?: boolean): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(32));
    }
    terminateSync(): void {
        // return Promise.resolve();
        // throw new Error("Method not implemented.");
    }
    async openReplication(
        setting: RemoteDBSettings,
        keepAlive: boolean,
        showResult: boolean,
        ignoreCleanLock: boolean
    ): Promise<void | boolean> {
        const logLevel = showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO;
        const r = await this.getP2PConnection(logLevel);
        if (!r) {
            return false;
        }
        await r.replicateFromCommand(showResult);
    }
    tryConnectRemote(setting: RemoteDBSettings, showResult?: boolean): Promise<boolean> {
        // throw new Error("Method not implemented.");
        return Promise.resolve(false);
    }
    replicateAllToServer(
        setting: RemoteDBSettings,
        showingNotice?: boolean,
        sendChunksInBulkDisabled?: boolean
    ): Promise<boolean> {
        // throw new Error("Method not implemented.");
        return Promise.resolve(false);
    }
    async openP2P(logLevel: LOG_LEVEL) {
        const r = getReplicatorInstance();
        if (!r) {
            Logger($msg("P2P.ReplicatorInstanceMissing"), logLevel);
            return false;
        }
        await r.open();
        return r;
    }
    async getP2PConnection(logLevel: LOG_LEVEL) {
        const r = getReplicatorInstance();
        if (!r) {
            Logger($msg("P2P.ReplicatorInstanceMissing"), logLevel);
            return false;
        }
        await r.makeSureOpened();
        return r;
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
        const message = `Rebuild from which peer?${settingPeerName ? `\n [*] indicates the peer you have selected before.` : ""}`;
        const confirm = await getConfirmInstance();
        // const peerNames = knownPeers.map(e => e.name);
        const markedPeerNames = knownPeers.map(
            (e) => `${e.name}\u2001${e.name == settingPeerName ? `[*]` : ""} (${e.peerId})`
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
            Logger(`Failed to find peerId for ${selectedPeerName}`, logLevel);
            return false;
        }
        return peerId;
    }
    async tryUntilSuccess<T>(func: () => Promise<T | false>, repeat: number, logLevel: LOG_LEVEL): Promise<T | false> {
        const confirm = await getConfirmInstance();
        if (!confirm) {
            Logger(`Cannot find confirm instance.`, logLevel);
            return Promise.reject(`Cannot find confirm instance.`);
        }
        let result;
        while (!result) {
            for (let i = 0; i < repeat; i++) {
                try {
                    result = await func();
                    if (result) {
                        break;
                    }
                } catch (e) {
                    // Logger(`Failed`, logLevel);
                    Logger(`Error: ${e}`, logLevel);
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
            // const message = `Rebuild from which peer?${settingPeerName ? `\n [*] indicates the peer you have selected before.` : ""}`;
            const confirm = await getConfirmInstance();
            if ((await confirm.askYesNoDialog($msg("P2P.DisabledButNeed"), {})) != "yes") {
                Logger($msg("P2P.NotEnabled"), logLevel);
            }
            setting.P2P_Enabled = true;
            this.env.settings.P2P_Enabled = true;
            await this.env.$$saveSettingData();
            await delay(100);
            return this.replicateAllFromServer(setting, showingNotice);
        }
        // Establish P2P connection
        eventHub.emitEvent(EVENT_P2P_REQUEST_FORCE_OPEN);
        await eventHub.waitFor(EVENT_P2P_CONNECTED);
        // const somePeerAdArrived = eventHub.waitFor(EVENT_ADVERTISEMENT_RECEIVED);

        const peerFrom = setting.P2P_RebuildFrom;
        const instance = getReplicatorInstance();
        if (!instance) {
            Logger(`Failed to get replicator instance.`, logLevel);
            return false;
        }
        instance.setOnSetup();
        try {
            const r = await this.tryUntilSuccess(() => this.openP2P(logLevel), 10, logLevel);
            if (r === false) {
                Logger(`Failed to open P2P connection.`, logLevel);
                return false;
            }
            // await Promise.race([somePeerAdArrived, delay(10000)]);
            const peerId = await this.selectPeer(peerFrom, r, logLevel);
            if (peerId === false) {
                Logger(`Failed to connect peer.`, logLevel);
                return false;
            }
            this.env.settings.P2P_RebuildFrom = "";
            Logger(`Fetching from peer ${peerId}.`, logLevel);

            const rep = await r.replicateFrom(peerId, showingNotice);
            if (rep.ok) {
                Logger(`P2P Fetching has been succeed from ${peerId}.`, logLevel);
                return true;
            } else {
                Logger(`Failed to fetch from peer ${peerId}.`, logLevel);
                Logger(rep.error, LOG_LEVEL_VERBOSE);
                return false;
            }
        } finally {
            instance.clearOnSetup();
        }
    }
    closeReplication(): void {
        // throw new Error("Method not implemented.");
        const r = getReplicatorInstance();
        r?.disconnectFromServer();
        return;
    }
    tryResetRemoteDatabase(setting: RemoteDBSettings): Promise<void> {
        throw new Error("P2P replication does not support database reset.");
    }
    tryCreateRemoteDatabase(setting: RemoteDBSettings): Promise<void> {
        throw new Error("P2P replication does not support database reset.");
    }
    markRemoteLocked(setting: RemoteDBSettings, locked: boolean, lockByClean: boolean): Promise<void> {
        throw new Error("P2P replication does not support database lock.");
    }
    markRemoteResolved(setting: RemoteDBSettings): Promise<void> {
        // This may requires to
        Logger(
            `Trying resolving remote-database-lock but P2P replication does not support database lock. This operation has been ignored`,
            LOG_LEVEL_INFO
        );
        return Promise.resolve();
        // throw new Error("P2P replication does not support database lock.");
    }
    resetRemoteTweakSettings(setting: RemoteDBSettings): Promise<void> {
        throw new Error("P2P replication does not support resetting tweaks.");
    }
    setPreferredRemoteTweakSettings(setting: RemoteDBSettings): Promise<void> {
        Logger(
            `Trying setting tweak values but P2P replication does not support to do this. This operation has been ignored`,
            LOG_LEVEL_INFO
        );
        return Promise.resolve();
    }
    fetchRemoteChunks(missingChunks: string[], showResult: boolean): Promise<false | EntryLeaf[]> {
        return Promise.resolve(false);
    }
    getRemoteStatus(setting: RemoteDBSettings): Promise<false | RemoteDBStatus> {
        Logger(
            `Trying to get remote status but P2P replication does not support to do this. This operation has been ignored`,
            LOG_LEVEL_INFO
        );
        return Promise.resolve(false);
    }
    getRemotePreferredTweakValues(setting: RemoteDBSettings): Promise<false | TweakValues> {
        Logger(
            `Trying to get tweak values but P2P replication does not support to do this. This operation has been ignored`,
            LOG_LEVEL_INFO
        );
        return Promise.resolve(false);
    }

    /**
     * Count the number of compromised chunks in the remote database. (Not supported)
     * @returns The number of compromised chunks.
     */
    countCompromisedChunks(): Promise<number> {
        Logger(`P2P Replicator cannot count compromised chunks`, LOG_LEVEL_VERBOSE);
        return Promise.resolve(0);
    }

    env: LiveSyncTrysteroReplicatorEnv;
    constructor(env: LiveSyncTrysteroReplicatorEnv) {
        super(env);
        this.env = env;
        // Stub.
    }
}
