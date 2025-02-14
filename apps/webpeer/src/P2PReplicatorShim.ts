import {} from "../../../src/PlatformAPIs/SynchromeshLoader.browser";
import { PouchDB } from "../../../src/pouchdb/pouchdb-browser";
import { Synchromesh } from "../../../src/PlatformAPIs/Synchromesh";
import {
    type EntryDoc,
    type P2PSyncSetting,
    DEFAULT_SETTINGS,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_VERBOSE,
    P2P_DEFAULT_SETTINGS,
} from "../../../src/common/types";
import { eventHub } from "../../../src/hub/hub";
import { TrysteroReplicator, type P2PReplicationProgress } from "../../../src/replication/trystero/TrysteroReplicator";
import {
    EVENT_ADVERTISEMENT_RECEIVED,
    EVENT_DEVICE_LEAVED,
    EVENT_P2P_CONNECTED,
    EVENT_P2P_DISCONNECTED,
    EVENT_P2P_REPLICATOR_PROGRESS,
    EVENT_P2P_REQUEST_FORCE_OPEN,
    EVENT_REQUEST_STATUS,
} from "../../../src/replication/trystero/TrysteroReplicatorP2PServer";
import { EVENT_BROWSER_INFO_SUPPLIED } from "../../../src/PlatformAPIs/browser/base";
import type { CommandShim, PluginShim } from "../../../../features/P2PSync/P2PReplicator/P2PReplicatorPaneCommon";
import { EVENT_DATABASE_REBUILT, EVENT_SETTING_SAVED } from "../../../../common/events";
import { EVENT_PLATFORM_UNLOADED } from "../../../src/PlatformAPIs/base/APIBase";
import type { Confirm } from "../../../src/interfaces/Confirm";
import type { IEnvironment, ISimpleStoreAPI } from "../../../src/PlatformAPIs/interfaces";
import { setReplicatorFunc } from "../../../src/replication/trystero/LiveSyncTrysteroReplicator";
import { defaultLoggerEnv, Logger, setGlobalLogFunction } from "../../../src/common/logger";
import { $msg } from "../../../src/common/i18n";
import { writable } from "svelte/store";
import { setConfirmInstance } from "../../../src/PlatformAPIs/Confirm";
import { BrowserConfirm } from "../../../src/PlatformAPIs/browser/Confirm";

export const logs = writable([] as string[]);

let _logs = [] as string[];

const maxLines = 10000;
setGlobalLogFunction((msg, level) => {
    console.log(msg);
    const msgstr = typeof msg === "string" ? msg : JSON.stringify(msg);
    const strLog = `${new Date().toISOString()}\t${msgstr}`;
    _logs.push(strLog);
    if (_logs.length > maxLines) {
        _logs = _logs.slice(_logs.length - maxLines);
    }
    logs.set(_logs);
});
defaultLoggerEnv.minLogLevel = LOG_LEVEL_VERBOSE;

export type BindingApp = {
    cmdSync: CommandShim;
    plugin: PluginShim;
};
eventHub.emitEvent(EVENT_BROWSER_INFO_SUPPLIED, {
    vaultName: "--",
    manifestVersion: "0.0.1",
    packageVersion: "0.0.1",
});

import Popup from "./lib/Popup.svelte";
import { mount } from "svelte";
import { promiseWithResolver } from "octagonal-wheels/promises";

function askInPopup<T, U extends string[]>(
    message: string,
    buttons: U,
    title: string,
    commit: (ret: U[number]) => T
): Promise<T> {
    const el = document.createElement("div");
    const p = promiseWithResolver<T>();
    mount(Popup, {
        target: el,
        props: {
            message,
            buttons: buttons as string[],
            title: title,
            commit: (action: U[number]) => {
                const ret = commit(action);
                p.resolve(ret);
            },
        },
    });
    document.body.appendChild(el);
    void p.promise.finally(() => {
        el.remove();
    });
    return p.promise;
}
class ExtBrowserConfirm extends BrowserConfirm implements Confirm {
    askYesNo(message: string): Promise<"yes" | "no"> {
        return askInPopup(message, ["Yes", "No"] as const, "Confirm", (action) => (action == "Yes" ? "yes" : "no"));
    }
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false> {
        throw new Error("Method not implemented.");
    }
    askYesNoDialog(
        message: string,
        opt: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no"> {
        return askInPopup(message, ["Yes", "No"] as const, opt.title ?? "Confirm", (action) =>
            action == "Yes" ? "yes" : "no"
        );
    }
    askSelectString(message: string, items: string[]): Promise<string> {
        return askInPopup(message, [...items] as const, "Confirm", (action) => action);
    }
    askSelectStringDialogue<T extends readonly string[]>(
        message: string,
        buttons: T,
        opt: { title?: string; defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false> {
        return askInPopup(message, [...buttons] as const, opt.title ?? "Confirm", (action) => action);
    }
    askInPopup(key: string, dialogText: string, anchorCallback: (anchor: HTMLAnchorElement) => void): void {
        throw new Error("Method not implemented.");
    }
    confirmWithMessage(
        title: string,
        contentMd: string,
        buttons: string[],
        defaultAction: (typeof buttons)[number],
        timeout?: number
    ): Promise<(typeof buttons)[number] | false> {
        return askInPopup(contentMd, [...buttons] as const, title ?? "Confirm", (action) => action);
    }
}

const __confirm = new ExtBrowserConfirm();
setConfirmInstance(__confirm);

export class P2PReplicatorShim implements CommandShim {
    _replicatorInstance?: TrysteroReplicator;
    plugin!: PluginShim;
    confirm!: Confirm;
    simpleStoreAPI!: ISimpleStoreAPI;
    environment!: IEnvironment;

    get settings() {
        return this.plugin.settings;
    }

    constructor() {
        setReplicatorFunc(() => this._replicatorInstance);
        eventHub.onEvent(EVENT_ADVERTISEMENT_RECEIVED, (peerId) => this._replicatorInstance?.onNewPeer(peerId));
        eventHub.onEvent(EVENT_DEVICE_LEAVED, (info) => this._replicatorInstance?.onPeerLeaved(info));
        eventHub.onEvent(EVENT_REQUEST_STATUS, () => {
            this._replicatorInstance?.requestStatus();
        });
        eventHub.onEvent(EVENT_P2P_REQUEST_FORCE_OPEN, () => {
            void this.open();
        });

        eventHub.onEvent(EVENT_DATABASE_REBUILT, async () => {
            await this.initialiseP2PReplicator();
        });
        eventHub.onEvent(EVENT_PLATFORM_UNLOADED, () => {
            void this.close();
        });
        eventHub.onEvent(EVENT_SETTING_SAVED, async (settings: P2PSyncSetting) => {
            this.plugin.settings = settings;
            await this.initialiseP2PReplicator();
        });
        // --- Logs

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
    async init() {
        const synchronised = Synchromesh();
        setConfirmInstance(__confirm);
        const { confirm, environment, simpleStoreAPI } = await synchronised;

        this.confirm = confirm;
        this.environment = environment;
        this.simpleStoreAPI = simpleStoreAPI;

        const repStore = this.simpleStoreAPI.getSimpleStore<any>("p2p-livesync-web-peer");
        let _settings = (await repStore.get("settings")) || { ...P2P_DEFAULT_SETTINGS };
        this.plugin = {
            saveSettings: async () => {
                await repStore.set("settings", _settings);
                eventHub.emitEvent(EVENT_SETTING_SAVED, _settings);
            },
            get settings() {
                return _settings;
            },
            set settings(newSettings: P2PSyncSetting) {
                _settings = { ..._settings, ...newSettings };
            },
            rebuilder: null,
            $$scheduleAppReload: () => {},
            $$getVaultName: () => "p2p-livesync-web-peer",
        };
        await this.initialiseP2PReplicator();
        return this;
    }
    onunload(): void {
        void this.close();
    }

    async open() {
        if (!this.settings.P2P_Enabled) {
            Logger(($msg("P2P.NotEnabled"), LOG_LEVEL_NOTICE));
            return;
        }

        if (!this._replicatorInstance) {
            await this.initialiseP2PReplicator();
        } else {
            await this._replicatorInstance?.open();
        }
    }
    async close() {
        await this._replicatorInstance?.close();
        this._replicatorInstance = undefined;
    }
    getConfig(key: string) {
        const vaultName = this.plugin.$$getVaultName();
        const dbKey = `${vaultName}-${key}`;
        return localStorage.getItem(dbKey);
    }
    setConfig(key: string, value: string) {
        const vaultName = this.plugin.$$getVaultName();
        const dbKey = `${vaultName}-${key}`;
        localStorage.setItem(dbKey, value);
    }

    async initialiseP2PReplicator(): Promise<TrysteroReplicator> {
        // const getPlugin = () => this.plugin;
        try {
            // const plugin = this.plugin;
            if (this._replicatorInstance) {
                await this._replicatorInstance.close();
                this._replicatorInstance = undefined;
            }

            if (!this.settings.P2P_AppID) {
                this.settings.P2P_AppID = DEFAULT_SETTINGS.P2P_AppID;
            }
            const database_name = this.settings.P2P_AppID + "-" + this.settings.P2P_roomID;
            const db = new PouchDB<EntryDoc>(database_name);
            const initialDeviceName = this.getConfig("p2p_device_name") || "p2p-livesync-web-peer";
            const confirm = this.confirm;
            const getSettings = () => this.settings;
            const simpleStoreAPI = this.simpleStoreAPI;
            const store = simpleStoreAPI.getSimpleStore("p2p-livesync-web-peer");
            const env = {
                get db() {
                    return db;
                },
                get confirm() {
                    return confirm;
                },
                get deviceName() {
                    return initialDeviceName;
                },
                platform: "wip",
                get settings() {
                    return getSettings();
                },
                async processReplicatedDocs(docs: EntryDoc[]): Promise<void> {
                    // No op. This is a client and does not need to process the docs
                },
                simpleStore: store,
            };
            this._replicatorInstance = new TrysteroReplicator(env);
            if (this.settings.P2P_AutoStart && this.settings.P2P_Enabled) {
                await this.open();
            }
            return this._replicatorInstance;
        } catch (e) {
            Logger(
                e instanceof Error ? e.message : "Something occurred on Initialising P2P Replicator",
                LOG_LEVEL_INFO
            );
            Logger(e, LOG_LEVEL_VERBOSE);
            throw e;
        }
    }

    enableBroadcastCastings() {
        return this?._replicatorInstance?.enableBroadcastChanges();
    }
    disableBroadcastCastings() {
        return this?._replicatorInstance?.disableBroadcastChanges();
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
        storeP2PStatusLine.set(line);
    }
}
export const storeP2PStatusLine = writable("");

export const cmdSyncShim = new P2PReplicatorShim();
