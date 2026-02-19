import { ServiceContext } from "@lib/services/base/ServiceBase";
// Be sure to use only types here, to avoid circular dependencies
import type ObsidianLiveSyncPlugin from "@/main";
import type { App, Plugin } from "@/deps";

export class ObsidianServiceContext extends ServiceContext {
    app: App;
    plugin: Plugin;
    liveSyncPlugin: ObsidianLiveSyncPlugin;
    constructor(app: App, plugin: Plugin, liveSyncPlugin: ObsidianLiveSyncPlugin) {
        super();
        this.app = app;
        this.plugin = plugin;
        this.liveSyncPlugin = liveSyncPlugin;
    }
}
