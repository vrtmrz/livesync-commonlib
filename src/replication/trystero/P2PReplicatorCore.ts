import type { SimpleStore } from "octagonal-wheels/databases/SimpleStoreBase";

import { $msg } from "../../common/i18n";
import { type EntryDoc, type LOG_LEVEL, type P2PSyncSetting } from "../../common/types";
import { reactiveSource, type ReactiveSource } from "octagonal-wheels/dataobject/reactive";
import { EVENT_DATABASE_REBUILT, EVENT_SETTING_SAVED } from "../../events/coreEvents";
import { eventHub } from "../../hub/hub";
import type { Confirm } from "../../interfaces/Confirm";
import { EVENT_PLATFORM_UNLOADED } from "../../PlatformAPIs/base/APIBase";
import { setReplicatorFunc } from "./LiveSyncTrysteroReplicator";
import type { CommandShim, PluginShim } from "./P2PReplicatorPaneCommon";
import { type P2PReplicationProgress } from "./TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_DEVICE_LEAVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_DISCONNECTED,
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_P2P_REQUEST_FORCE_OPEN,
    EVENT_REQUEST_STATUS,
} from "./TrysteroReplicatorP2PServer";
import type { ServiceHub } from "../../services/ServiceHub";

export function setP2PReplicatorInstance(instance: CommandShim) {
    setReplicatorFunc(() => instance._replicatorInstance);
}

export function removeP2PReplicatorInstance() {
    setReplicatorFunc(() => undefined);
}

export function addP2PEventHandlers(instance: CommandShim) {
    eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (peerId) => instance._replicatorInstance?.onNewPeer(peerId));
    eventHub.onEvent(EVENT_DEVICE_LEAVED, (info) => instance._replicatorInstance?.onPeerLeaved(info));
    eventHub.onEvent(EVENT_REQUEST_STATUS, () => {
        instance._replicatorInstance?.requestStatus();
    });
    eventHub.onEvent(EVENT_DATABASE_REBUILT, async () => {
        await instance.initialiseP2PReplicator();
    });
    eventHub.onEvent(EVENT_P2P_REQUEST_FORCE_OPEN, () => {
        // Only `shim` has this method, why?
        // TODO: Check if this is a bug
        void instance.open();
    });
    eventHub.onEvent(EVENT_PLATFORM_UNLOADED, () => {
        void instance.close();
    });
    eventHub.onEvent(EVENT_SETTING_SAVED, async (settings: P2PSyncSetting) => {
        // this.plugin.settings = settings; // Only `shim` has this. seems not needed.
        await instance.initialiseP2PReplicator();
    });
}

export async function openP2PReplicator(instance: CommandShim) {
    if (!instance.settings.P2P_Enabled) {
        instance._notice($msg("P2P.NotEnabled"));
        return;
    }

    if (!instance._replicatorInstance) {
        await instance.initialiseP2PReplicator();
        await instance._replicatorInstance!.open();
    } else {
        await instance._replicatorInstance?.open();
    }
}
export async function closeP2PReplicator(instance: CommandShim) {
    await instance._replicatorInstance?.close();
    instance._replicatorInstance = undefined;
}

export class P2PLogCollector {
    constructor() {
        eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (data) => {
            this.p2pReplicationResult.set(data.peerId, {
                peerId: data.peerId,
                peerName: data.name,
                fetching: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
                sending: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
            });
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_CONNECTED, () => {
            this.p2pReplicationResult.clear();
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_DISCONNECTED, () => {
            this.p2pReplicationResult.clear();
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_DEVICE_LEAVED, (peerId) => {
            this.p2pReplicationResult.delete(peerId);
            this.updateP2PReplicationLine();
        });
        eventHub.onEvent(EVENT_P2P_REPLICATOR_PROGRESS, (data) => {
            const prev = this.p2pReplicationResult.get(data.peerId) || {
                peerId: data.peerId,
                peerName: data.peerName,
                fetching: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
                sending: {
                    current: 0,
                    max: 0,
                    isActive: false,
                },
            };
            if ("fetching" in data) {
                if (data.fetching.isActive) {
                    prev.fetching = data.fetching;
                } else {
                    prev.fetching.isActive = false;
                }
            }
            if ("sending" in data) {
                if (data.sending.isActive) {
                    prev.sending = data.sending;
                } else {
                    prev.sending.isActive = false;
                }
            }
            this.p2pReplicationResult.set(data.peerId, prev);
            this.updateP2PReplicationLine();
        });
    }
    p2pReplicationResult = new Map<string, P2PReplicationProgress>();
    updateP2PReplicationLine() {
        const p2pReplicationResultX = [...this.p2pReplicationResult.values()].sort((a, b) =>
            a.peerId.localeCompare(b.peerId)
        );
        const renderProgress = (current: number, max: number) => {
            if (current == max) return `${current}`;
            return `${current} (${max})`;
        };
        const line = p2pReplicationResultX
            .map(
                (e) =>
                    `${e.fetching.isActive || e.sending.isActive ? "⚡" : "💤"} ${e.peerName} ↑ ${renderProgress(e.sending.current, e.sending.max)} ↓ ${renderProgress(e.fetching.current, e.fetching.max)} `
            )
            .join("\n");
        this.p2pReplicationLine.value = line;
    }
    p2pReplicationLine = reactiveSource("");
}

export interface P2PReplicatorBase {
    storeP2PStatusLine: ReactiveSource<string>;
    plugin: PluginShim;
    settings: P2PSyncSetting;
    _log(msg: any, level?: LOG_LEVEL): void;
    _notice(msg: any, key?: string): void;

    getSettings(): P2PSyncSetting;
    getDB: () => PouchDB.Database<EntryDoc>;
    confirm: Confirm;
    simpleStore(): SimpleStore<any>;
    handleReplicatedDocuments(docs: EntryDoc[]): Promise<void>;
    init(): Promise<this>;

    services: ServiceHub;
}
