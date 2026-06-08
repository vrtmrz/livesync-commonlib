import type { Confirm } from "@lib/interfaces/Confirm";
import type { ComponentHasResult, SvelteDialogManagerBase } from "@lib/UI/svelteDialog";
import type { IAPIService, IUIService } from "@lib/services/base/IService";

import { type AppLifecycleService } from "@lib/services/base/AppLifecycleService.ts";
import { ServiceBase, type ServiceContext } from "@lib/services/base/ServiceBase";

export type UIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    dialogManager: SvelteDialogManagerBase<T>;
    APIService: IAPIService;
};

type DialogResult = "ok" | "cancel";
type DialogParams = {
    title: string;
    dataToCopy: string;
};

export abstract class UIService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements IUIService
{
    private _dialogManager: SvelteDialogManagerBase<T>;
    protected _APIService: IAPIService;
    abstract get dialogToCopy(): ComponentHasResult<DialogResult, DialogParams>;
    constructor(context: T, dependents: UIServiceDependencies<T>) {
        super(context);
        this._dialogManager = dependents.dialogManager;
        this._APIService = dependents.APIService;
    }
    get dialogManager(): SvelteDialogManagerBase<T> {
        return this._dialogManager;
    }

    async promptCopyToClipboard(title: string, value: string): Promise<boolean> {
        const param = {
            title: title,
            dataToCopy: value,
        };
        const result = await this._dialogManager.open<DialogResult, DialogParams>(this.dialogToCopy, param);
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
        return this._APIService.confirm.askSelectStringDialogue(contentMD, buttons, {
            title,
            defaultAction: defaultAction ?? buttons[0],
            timeout: 0,
        });
    }
    get confirm(): Confirm {
        return this._APIService.confirm;
    }
}
