import type { Confirm } from "@lib/interfaces/Confirm";
import type { ComponentHasResult, SvelteDialogManager } from "@lib/services/implements/base/SvelteDialog";
import type { IAPIService, IUIService } from "@lib/services/base/IService";

import { ServiceBase, type ServiceContext } from "@lib/services/base/ServiceBase";

export type UIServiceDependencies<T extends ServiceContext = ServiceContext> = {
    dialogManager: SvelteDialogManager<T>;
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
    private _dialogManager: SvelteDialogManager<T>;
    protected _APIService: IAPIService;
    abstract get dialogToCopy(): ComponentHasResult<DialogResult, DialogParams>;
    constructor(context: T, dependents: UIServiceDependencies<T>) {
        super(context);
        this._dialogManager = dependents.dialogManager;
        this._APIService = dependents.APIService;
    }
    get dialogManager(): SvelteDialogManager<T> {
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
