import { type AppLifecycleService } from "@lib/services/base/AppLifecycleService";

import { InjectableAppLifecycleService } from "@lib/services/implements/injectable/InjectableAppLifecycleService";
import { InjectableConflictService } from "@lib/services/implements/injectable/InjectableConflictService";
import { InjectableDatabaseEventService } from "@lib/services/implements/injectable/InjectableDatabaseEventService";
import { InjectableFileProcessingService } from "@lib/services/implements/injectable/InjectableFileProcessingService";
import { PathServiceCompat } from "@lib/services/implements/injectable/InjectablePathService";
import { InjectableRemoteService } from "@lib/services/implements/injectable/InjectableRemoteService";
import { InjectableReplicationService } from "@lib/services/implements/injectable/InjectableReplicationService";
import { InjectableReplicatorService } from "@lib/services/implements/injectable/InjectableReplicatorService";
import { InjectableSettingService } from "@lib/services/implements/injectable/InjectableSettingService";
import { InjectableTestService } from "@lib/services/implements/injectable/InjectableTestService";
import { InjectableTweakValueService } from "@lib/services/implements/injectable/InjectableTweakValueService";
import { InjectableVaultServiceCompat } from "@lib/services/implements/injectable/InjectableVaultService";
import { ServiceContext } from "@lib/services/base/ServiceBase";
import { ConfigServiceBrowserCompat } from "@lib/services/implements/browser/ConfigServiceBrowserCompat";
import { InjectableServiceHub } from "@lib/services/implements/injectable/InjectableServiceHub";
import type { ServiceInstances } from "@lib/services/ServiceHub";

import type { Confirm } from "../interfaces/Confirm";

import { UIService } from "@lib/services/implements/base/UIService";
import { HeadlessAPIService } from "./implements/headless/HeadlessAPIService";
import { HeadlessDatabaseService } from "./implements/headless/HeadlessDatabaseService";
import { SvelteDialogManagerBase, type ComponentHasResult } from "./implements/base/SvelteDialog";

class HeadlessConfirm implements Confirm {
    askYesNo(message: string): Promise<"yes" | "no"> {
        throw new Error("Method not implemented.");
    }
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false> {
        throw new Error("Method not implemented.");
    }
    askYesNoDialog(
        message: string,
        opt: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no"> {
        throw new Error("Method not implemented.");
    }
    askSelectString(message: string, items: string[]): Promise<string> {
        throw new Error("Method not implemented.");
    }
    askSelectStringDialogue<T extends readonly string[]>(
        message: string,
        buttons: T,
        opt: { title?: string; defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false> {
        throw new Error("Method not implemented.");
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
        throw new Error("Method not implemented.");
    }
}
class HeadlessSvelteDialogManager<T extends ServiceContext> extends SvelteDialogManagerBase<T> {
    openSvelteDialog<T, U>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T | undefined> {
        throw new Error("Method not implemented.");
    }
}

type HeadlessUIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    config: ConfigServiceBrowserCompat<T>;
    replicator: InjectableReplicatorService<T>;
};

class HeadlessUIService extends UIService<ServiceContext> {
    override get dialogToCopy(): never {
        throw new Error("Method not implemented.");
    }
    constructor(context: ServiceContext, dependents: HeadlessUIServiceDependencies<ServiceContext>) {
        const headlessConfirm = new HeadlessConfirm();
        const headlessSvelteDialogManager = new HeadlessSvelteDialogManager<ServiceContext>(context, {
            confirm: headlessConfirm,
            appLifecycle: dependents.appLifecycle,
            config: dependents.config,
            replicator: dependents.replicator,
        });
        super(context, {
            appLifecycle: dependents.appLifecycle,
            dialogManager: headlessSvelteDialogManager,
            confirm: headlessConfirm,
        });
    }
}

export class HeadlessServiceHub extends InjectableServiceHub<ServiceContext> {
    constructor() {
        const context = new ServiceContext();

        const API = new HeadlessAPIService(context);
        const appLifecycle = new InjectableAppLifecycleService(context);
        const conflict = new InjectableConflictService(context);
        const database = new HeadlessDatabaseService(context);
        const fileProcessing = new InjectableFileProcessingService(context);
        const replication = new InjectableReplicationService(context);
        const replicator = new InjectableReplicatorService(context);
        const remote = new InjectableRemoteService(context);
        const setting = new InjectableSettingService(context);
        const tweakValue = new InjectableTweakValueService(context);
        const vault = new InjectableVaultServiceCompat(context, {
            settingService: setting,
        });
        const test = new InjectableTestService(context);
        const databaseEvents = new InjectableDatabaseEventService(context);
        const path = new PathServiceCompat(context, {
            settingService: setting,
        });
        const config = new ConfigServiceBrowserCompat<ServiceContext>(context, vault);
        const ui = new HeadlessUIService(context, {
            appLifecycle,
            config,
            replicator,
        });
        // Using 'satisfies' to ensure all services are provided
        const serviceInstancesToInit = {
            appLifecycle: appLifecycle,
            conflict: conflict,
            database: database,
            databaseEvents: databaseEvents,
            fileProcessing: fileProcessing,
            replication: replication,
            replicator: replicator,
            remote: remote,
            setting: setting,
            tweakValue: tweakValue,
            vault: vault,
            test: test,
            ui: ui,
            path: path,
            API: API,
            config: config,
        } satisfies Required<ServiceInstances<ServiceContext>>;

        super(context, serviceInstancesToInit);
    }
}
