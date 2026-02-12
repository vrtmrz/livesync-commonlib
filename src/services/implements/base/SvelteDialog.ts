import type { ConfigService } from "@lib/services/base/ConfigService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { ReplicatorService } from "@lib/services/base/ReplicatorService";
import type { Confirm } from "@/lib/src/interfaces/Confirm";
import { getContext, mount, setContext, unmount, type Component } from "svelte";
import { LOG_LEVEL_NOTICE, Logger } from "@/lib/src/common/logger";
import { fireAndForget, promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { eventHub } from "@/lib/src/hub/hub";
import { EVENT_PLUGIN_UNLOADED } from "@/lib/src/events/coreEvents";

import type { ServiceContext } from "@lib/services/base/ServiceBase";

export type SvelteDialogManagerDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    replicator: ReplicatorService<T>;
    config: ConfigService<T>;
    confirm: Confirm;
};

export type HasSetResult<T = any> = {
    setResult: (result: T) => void;
};
export type HasGetInitialData<T = any> = {
    getInitialData?: () => T | undefined;
};
export type ComponentHasResult<T = any, U = any> = Component<HasSetResult<T> & HasGetInitialData<U>>;
export type GuestDialogProps<T = any, U = any> = HasSetResult<T> & HasGetInitialData<U>;
export type DialogSvelteComponentBaseProps = {
    // component: Component;
    setTitle: (title: string) => void;
    closeDialog: () => void;
} & HasSetResult &
    HasGetInitialData;

export type DialogControlBase<T = any, U = any> = {
    setTitle: (title: string) => void;
    closeDialog: () => void;
} & HasSetResult<T> &
    HasGetInitialData<U>;
export type DialogHostProps = DialogSvelteComponentBaseProps & {
    /**
     * The Svelte component to mount inside the dialog host
     */
    mountComponent: ComponentHasResult<any>;
    /**
     * Callback function to setup the dialog context
     * @param props
     */
    onSetupContext?(props: DialogSvelteComponentBaseProps): void;
};
export type DialogContext<C extends ServiceContext = ServiceContext, T = any, U = any> = DialogControlBase<T, U> & {
    context: C;
    services: SvelteDialogManagerDependencies<C>;
};

export const CONTEXT_DIALOG_CONTROLS = "svelte-dialog-controls";
export function setupDialogContext<T extends DialogContext>(controls: T) {
    setContext(CONTEXT_DIALOG_CONTROLS, controls);
}
export function getDialogContext<T = any, U = any>(): DialogContext<ServiceContext, T, U> {
    return getContext<DialogContext<ServiceContext, T, U>>(CONTEXT_DIALOG_CONTROLS);
}

type Constructor<TResult> = new (...args: any[]) => TResult;

export interface IModalBase {
    // context: C;
    contentEl: HTMLElement;
    // result?: T;
    // initialData?: U;
    close(): void;
    setTitle(title: string): void;
    onOpen(): void;
    onClose(): void;
    open(): void;
}
export function SvelteDialogMixIn<TBase extends Constructor<IModalBase>>(TBase: TBase, d: Component<DialogHostProps>) {
    return class SvelteDialog<
        T,
        U,
        C extends ServiceContext = ServiceContext,
    > extends (TBase as Constructor<IModalBase>) {
        constructor(...args: any[]) {
            super(...args);
        }
        // plugin: ObsidianLiveSyncPlugin;
        private _context!: C;
        get context(): C {
            return this._context;
        }
        private dependents!: SvelteDialogManagerDependencies<C>;
        mountedComponent?: ReturnType<typeof mount>;
        component!: ComponentHasResult<T, U>;
        result?: T;
        initialData?: U;
        title: string = "Obsidian LiveSync - Setup Wizard";

        initDialog(
            context: C,
            dependents: SvelteDialogManagerDependencies<C>,
            component: ComponentHasResult<T, U>,
            initialData?: U
        ) {
            this._context = context;
            this.dependents = dependents;
            this.component = component;
            this.initialData = initialData;
        }
        resolveResult() {
            this.resultPromiseWithResolvers?.resolve(this.result);
            this.resultPromiseWithResolvers = undefined;
        }
        resultPromiseWithResolvers?: PromiseWithResolvers<T | undefined>;
        onOpen() {
            const { contentEl } = this;
            contentEl.empty();
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const dialog = this;

            if (this.resultPromiseWithResolvers) {
                this.resultPromiseWithResolvers.reject("Dialog opened again");
            }
            const pr = promiseWithResolvers<any>();
            eventHub.once(EVENT_PLUGIN_UNLOADED, () => {
                if (this.resultPromiseWithResolvers === pr) {
                    pr.reject("Plugin unloaded");
                    this.close();
                }
            });
            this.resultPromiseWithResolvers = pr;
            this.mountedComponent = mount(d, {
                target: contentEl,
                props: {
                    onSetupContext: (props: DialogSvelteComponentBaseProps) => {
                        setupDialogContext({
                            ...props,
                            context: this.context,
                            services: this.dependents,
                        } satisfies DialogContext<C>);
                    },
                    setTitle: (title: string) => {
                        dialog.setTitle(title);
                    },
                    closeDialog: () => {
                        dialog.close();
                    },
                    setResult: (result: T) => {
                        this.result = result;
                    },
                    getInitialData: () => this.initialData,
                    mountComponent: this.component,
                },
            });
        }
        waitForClose(): Promise<T | undefined> {
            if (!this.resultPromiseWithResolvers) {
                throw new Error("Dialog not opened yet");
            }
            return this.resultPromiseWithResolvers.promise;
        }
        onClose() {
            this.resolveResult();
            fireAndForget(async () => {
                if (this.mountedComponent) {
                    await unmount(this.mountedComponent);
                }
            });
        }
    };
}

export abstract class SvelteDialogManagerBase<T extends ServiceContext> {
    abstract openSvelteDialog<T, U>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T | undefined>;

    protected _context: T;
    protected _dependents: SvelteDialogManagerDependencies<T>;
    get context(): T {
        return this._context;
    }

    get dependents(): SvelteDialogManagerDependencies<T> {
        return this._dependents;
    }

    constructor(c: T, dependents: SvelteDialogManagerDependencies<T>) {
        this._context = c;
        this._dependents = dependents;
    }
    async open<T, U>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T | undefined> {
        return await this.openSvelteDialog<T, U>(component, initialData);
    }
    async openWithExplicitCancel<T, U>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T> {
        for (let i = 0; i < 10; i++) {
            const ret = await this.openSvelteDialog<T, U>(component, initialData);
            if (ret !== undefined) {
                return ret;
            }
            if (this.dependents.appLifecycle.hasUnloaded()) {
                throw new Error("Operation cancelled due to app shutdown.");
            }
            Logger("Please select 'Cancel' explicitly to cancel this operation.", LOG_LEVEL_NOTICE);
        }
        throw new Error("Operation Forcibly cancelled by user.");
    }
}
