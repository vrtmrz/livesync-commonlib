import { UIService } from "@/lib/src/services/implements/base/UIService";
import type { ConfigService } from "@lib/services/base/ConfigService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { ReplicatorService } from "@lib/services/base/ReplicatorService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { BrowserConfirm } from "./BrowserConfirm";
import { BrowserSvelteDialogManager } from "./SvelteDialogBrowser";
import DialogToCopy from "@/lib/src/UI/dialogues/DialogueToCopy.svelte";

export type BrowserUIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    config: ConfigService<T>;
    replicator: ReplicatorService<T>;
};

export class BrowserUIService<T extends ServiceContext> extends UIService<T> {
    override get dialogToCopy() {
        return DialogToCopy;
    }
    constructor(context: T, dependents: BrowserUIServiceDependencies<T>) {
        const browserConfirm = new BrowserConfirm(context);
        const obsidianSvelteDialogManager = new BrowserSvelteDialogManager<T>(context, {
            appLifecycle: dependents.appLifecycle,
            config: dependents.config,
            replicator: dependents.replicator,
            confirm: browserConfirm,
        });
        super(context, {
            appLifecycle: dependents.appLifecycle,
            dialogManager: obsidianSvelteDialogManager,
            confirm: browserConfirm,
        });
    }
}
