import {} from "../../../src/PlatformAPIs/SynchromeshLoader.browser";
import { LOG_LEVEL_VERBOSE } from "../../../src/common/types";
import { eventHub } from "../../../src/hub/hub";
import { EVENT_BROWSER_INFO_SUPPLIED } from "../../../src/PlatformAPIs/browser/base";

import { defaultLoggerEnv, setGlobalLogFunction } from "../../../src/common/logger";
import { writable } from "svelte/store";

export const logs = writable([] as string[]);

let _logs = [] as string[];

const maxLines = 10000;
setGlobalLogFunction((msg, level) => {
    console.log(msg);
    const msgstr = typeof msg === "string" ? msg : JSON.stringify(msg);
    const strLog = `${new Date().toISOString()}\u2001${msgstr}`;
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

import { Synchromesh } from "../../../src/PlatformAPIs/Synchromesh";
import type { CommandShim, PluginShim } from "../../../src/replication/trystero/P2PReplicatorPaneCommon";

export const storeP2PStatusLine = writable("");

export async function getWrappedSynchromesh(): ReturnType<typeof Synchromesh> {
    const synchronised = await Synchromesh();
    return synchronised;
}
