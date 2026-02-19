import { EVENT_SETTING_SAVED } from "@lib/events/coreEvents";
import type { ServiceContext } from "../../base/ServiceBase";
import { SettingService, type SettingServiceDependencies } from "../../base/SettingService";
import { EVENT_REQUEST_RELOAD_SETTING_TAB } from "@/common/events";

import { eventHub } from "@lib/hub/hub";
import type { ObsidianLiveSyncSettings } from "@lib/common/types";
import { handlers } from "../../lib/HandlerUtils";

export class InjectableSettingService<T extends ServiceContext> extends SettingService<T> {
    constructor(context: T, dependencies: SettingServiceDependencies) {
        super(context, dependencies);
        this.onSettingSaved.addHandler((settings) => {
            eventHub.emitEvent(EVENT_SETTING_SAVED, settings);
            return Promise.resolve(true);
        });
        this.onSettingLoaded.addHandler((settings) => {
            eventHub.emitEvent(EVENT_REQUEST_RELOAD_SETTING_TAB);
            return Promise.resolve(true);
        });
    }
    protected setItem(key: string, value: string) {
        return localStorage.setItem(key, value);
    }
    protected getItem(key: string): string {
        return localStorage.getItem(key) ?? "";
    }
    protected deleteItem(key: string): void {
        localStorage.removeItem(key);
    }

    // override currentSettings = handlers<SettingService<T>>().binder("currentSettings");

    saveData = handlers<{ saveData: (data: ObsidianLiveSyncSettings) => Promise<void> }>().binder("saveData");
    loadData = handlers<{ loadData: () => Promise<ObsidianLiveSyncSettings | undefined> }>().binder("loadData");
}
