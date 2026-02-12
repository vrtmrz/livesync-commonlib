import type { Confirm } from "@lib/interfaces/Confirm";
import type { ComponentHasResult, SvelteDialogManagerBase } from "@lib/UI/svelteDialog";
import type { IUIService } from "@lib/services/base/IService";

import { type AppLifecycleService } from "@lib/services/base/AppLifecycleService.ts";
import { ServiceBase, type ServiceContext } from "@lib/services/base/ServiceBase";

export type UIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    dialogManager: SvelteDialogManagerBase<T>;
    confirm: Confirm;
};

export abstract class UIService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IUIService
{
    _confirmInstance: Confirm;
    private _dialogManager: SvelteDialogManagerBase<T>;
    abstract get dialogToCopy(): ComponentHasResult<"ok" | "cancel", { title: string; dataToCopy: string }>;
    constructor(context: T, dependents: UIServiceDependencies<T>) {
        super(context);
        this._confirmInstance = dependents.confirm;
        this._dialogManager = dependents.dialogManager;
    }
    get dialogManager(): SvelteDialogManagerBase<T> {
        return this._dialogManager;
    }

    async promptCopyToClipboard(title: string, value: string): Promise<boolean> {
        const param = {
            title: title,
            dataToCopy: value,
        };
        const result = await this._dialogManager.open(this.dialogToCopy, param);
        if (result !== "ok") {
            return false;
        }
        return true;
    }

    showMarkdownDialog<T extends string[]>(
        title: string,
        contentMD: string,
        buttons: T,
        defaultAction?: (typeof buttons)[number]
    ): Promise<(typeof buttons)[number] | false> {
        return this._confirmInstance.askSelectStringDialogue(contentMD, buttons, {
            title,
            defaultAction: defaultAction ?? buttons[0],
            timeout: 0,
        });
    }
    get confirm(): Confirm {
        return this._confirmInstance;
    }
}
