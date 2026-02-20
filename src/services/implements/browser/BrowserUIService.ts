import { UIService } from "@lib/services/implements/base/UIService";
import type { ConfigService } from "@lib/services/base/ConfigService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { ReplicatorService } from "@lib/services/base/ReplicatorService";
import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { BrowserSvelteDialogManager } from "./SvelteDialogBrowser";
import DialogToCopy from "@lib/UI/dialogues/DialogueToCopy.svelte";
import type { IAPIService, IControlService } from "../../base/IService";

export type BrowserUIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    config: ConfigService<T>;
    replicator: ReplicatorService<T>;
    APIService: IAPIService;
    control: IControlService;
};

export class BrowserUIService<T extends ServiceContext> extends UIService<T> {
    override get dialogToCopy() {
        return DialogToCopy;
    }
    constructor(context: T, dependents: BrowserUIServiceDependencies<T>) {
        const browserConfirm = dependents.APIService.confirm;
        const obsidianSvelteDialogManager = new BrowserSvelteDialogManager<T>(context, {
            appLifecycle: dependents.appLifecycle,
            config: dependents.config,
            replicator: dependents.replicator,
            confirm: browserConfirm,
            control: dependents.control,
        });
        super(context, {
            appLifecycle: dependents.appLifecycle,
            dialogManager: obsidianSvelteDialogManager,
            APIService: dependents.APIService,
        });
    }
}
