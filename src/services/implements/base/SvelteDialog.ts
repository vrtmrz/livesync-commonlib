import type { ConfigService } from "@lib/services/base/ConfigService";
import type { AppLifecycleService } from "@lib/services/base/AppLifecycleService";
import type { ReplicatorService } from "@lib/services/base/ReplicatorService";
import type { Confirm } from "@lib/interfaces/Confirm";
import { getContext, mount, setContext, unmount, type Component } from "svelte";
import { LOG_LEVEL_NOTICE, Logger } from "@lib/common/logger";
import { fireAndForget, promiseWithResolvers, type PromiseWithResolvers } from "octagonal-wheels/promises";
import { EVENT_PLUGIN_UNLOADED } from "@lib/events/coreEvents";

import type { ServiceContext } from "@lib/services/base/ServiceBase";
import type { IControlService } from "@lib/services/base/IService";
import type { Constructor } from "@lib/common/utils.type";

export type SvelteDialogManagerDependencies<T extends ServiceContext = ServiceContext> = {
    appLifecycle: AppLifecycleService<T>;
    replicator: ReplicatorService<T>;
    config: ConfigService<T>;
    confirm: Confirm;
    control: IControlService;
};

export type HasSetResult<T> = {
    setResult: (result: T) => void;
};
export type HasGetInitialData<T> = {
    getInitialData?: () => T | undefined;
};
export type ComponentHasResult<T, U> = Component<HasSetResult<T> & HasGetInitialData<U>>;
export type GuestDialogProps<T, U> = HasSetResult<T> & HasGetInitialData<U>;
export type DialogSvelteComponentBaseProps<T, U> = {
    // component: Component;
    setTitle: (title: string) => void;
    closeDialog: () => void;
} & HasSetResult<T> &
    HasGetInitialData<U>;

export type DialogControlBase<T, U> = {
    setTitle: (title: string) => void;
    closeDialog: () => void;
} & HasSetResult<T> &
    HasGetInitialData<U>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- base type.
export type DialogHostProps<T = any, U = any> = DialogSvelteComponentBaseProps<T, U> & {
    /**
     * The Svelte component to mount inside the dialog host
     */
    mountComponent: ComponentHasResult<T, U>;
    /**
     * Callback function to setup the dialog context
     * @param props
     */
    onSetupContext?(props: DialogSvelteComponentBaseProps<T, U>): void;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- base type.
export type DialogContext<C extends ServiceContext = ServiceContext, T = any, U = any> = DialogControlBase<T, U> & {
    context: C;
    services: SvelteDialogManagerDependencies<C>;
};

export interface SvelteDialogManager<T extends ServiceContext> {
    open<TResult, TInitial = TResult>(
        component: ComponentHasResult<TResult, TInitial>,
        initialData?: TInitial
    ): Promise<TResult | undefined>;
    openWithExplicitCancel<TResult, TInitial = TResult>(
        component: ComponentHasResult<TResult, TInitial>,
        initialData?: TInitial
    ): Promise<TResult>;
}

export const CONTEXT_DIALOG_CONTROLS = "svelte-dialog-controls";
export function setupDialogContext<T extends DialogContext>(controls: T) {
    setContext(CONTEXT_DIALOG_CONTROLS, controls);
}
export function getDialogContext<T = unknown, U = unknown>(): DialogContext<ServiceContext, T, U> {
    return getContext<DialogContext<ServiceContext, T, U>>(CONTEXT_DIALOG_CONTROLS);
}

// type Constructor<TResult> = new (...args: any[]) => TResult;

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

export interface SvelteDialogInstance<T, U, C extends ServiceContext = ServiceContext> extends IModalBase {
    initDialog(
        context: C,
        dependents: SvelteDialogManagerDependencies<C>,
        component: ComponentHasResult<T, U>,
        initialData?: U
    ): void;
    waitForClose(): Promise<T | undefined>;
}

export type SvelteDialogClass<TBase extends Constructor<IModalBase>> = {
    new <T, U, C extends ServiceContext = ServiceContext>(
        ...args: ConstructorParameters<TBase>
    ): SvelteDialogInstance<T, U, C>;
};

export function SvelteDialogMixIn<TBase extends Constructor<IModalBase>>(
    TBase: TBase,
    d: Component<DialogHostProps>
): SvelteDialogClass<TBase> {
    const SvelteDialog = class SvelteDialog<
        T,
        U,
        C extends ServiceContext = ServiceContext,
    > extends (TBase as Constructor<IModalBase>) {
        constructor(...args: ConstructorParameters<TBase>) {
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
        title: string = "Self-hosted LiveSync - Setup Wizard";

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
        override onOpen() {
            const { contentEl } = this;
            contentEl.replaceChildren();
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const dialog = this;

            if (this.resultPromiseWithResolvers) {
                this.resultPromiseWithResolvers.reject("Dialog opened again");
            }
            const pr = promiseWithResolvers<T | undefined>();
            this.context.events.once(EVENT_PLUGIN_UNLOADED, () => {
                if (this.resultPromiseWithResolvers === pr) {
                    pr.reject("Plugin unloaded");
                    this.close();
                }
            });
            this.resultPromiseWithResolvers = pr;
            this.mountedComponent = mount(d, {
                target: contentEl,
                props: {
                    onSetupContext: (props: DialogSvelteComponentBaseProps<T, U>) => {
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
        override onClose() {
            this.resolveResult();
            fireAndForget(async () => {
                if (this.mountedComponent) {
                    await unmount(this.mountedComponent);
                }
            });
        }
    };
    return SvelteDialog as SvelteDialogClass<TBase>;
}

export abstract class SvelteDialogManagerBase<T extends ServiceContext> implements SvelteDialogManager<T> {
    abstract openSvelteDialog<T, U = T>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T | undefined>;

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
    async open<T, U = T>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T | undefined> {
        return await this.openSvelteDialog<T, U>(component, initialData);
    }
    async openWithExplicitCancel<T, U = T>(component: ComponentHasResult<T, U>, initialData?: U): Promise<T> {
        for (let i = 0; i < 10; i++) {
            const ret = await this.openSvelteDialog<T, U>(component, initialData);
            if (ret !== undefined) {
                return ret;
            }
            if (this.dependents.control.hasUnloaded()) {
                throw new Error("Operation cancelled due to app shutdown.");
            }
            Logger(
                this.context.translate("Please select 'Cancel' explicitly to cancel this operation."),
                LOG_LEVEL_NOTICE
            );
        }
        throw new Error("Operation Forcibly cancelled by user.");
    }
}
