import {
    type ComponentHasResult,
    SvelteDialogManagerBase,
    SvelteDialogMixIn,
} from "@lib/services/implements/base/SvelteDialog.ts";
import type { ServiceContext } from "@lib/services/base/ServiceBase.ts";
import type { SvelteDialogManagerDependencies } from "@lib/services/implements/base/SvelteDialog";
import DialogHost from "@lib/UI/DialogHost.svelte";
import { _activeDocument } from "@lib/common/coreEnvFunctions.ts";

export type DialogMessageProps = Record<string, any>;

export class ShimModal {
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;
    isOpen: boolean = false;
    baseEl: HTMLElement;
    constructor() {
        const baseEl = _activeDocument.createElement("popup");
        this.baseEl = baseEl;
        this.contentEl = _activeDocument.createElement("div");
        this.contentEl.className = "modal-content";
        this.titleEl = _activeDocument.createElement("div");
        this.titleEl.className = "modal-title";
        this.modalEl = _activeDocument.createElement("div");
        this.modalEl.className = "modal";
        this.modalEl.style.display = "none";
        this.modalEl.appendChild(this.titleEl);
        this.modalEl.appendChild(this.contentEl);
        this.baseEl.appendChild(this.modalEl);
    }
    open() {
        this.isOpen = true;
        this.modalEl.style.display = "block";
        if (!this.baseEl.parentElement) {
            _activeDocument.body.appendChild(this.baseEl);
        }
        this.onOpen();
    }
    close() {
        this.isOpen = false;
        this.baseEl.style.display = "none";
        this.baseEl.remove();
        this.onClose();
    }
    onOpen() {}
    onClose() {}
    setPlaceholder(p: string) {}
    setTitle(t: string) {
        this.titleEl.textContent = t;
    }
}

const BrowserSvelteDialogBase = SvelteDialogMixIn(ShimModal, DialogHost);

export class SvelteDialogBrowser<T, U, C extends ServiceContext = ServiceContext> extends BrowserSvelteDialogBase<
    T,
    U,
    C
> {
    constructor(
        context: C,
        dependents: SvelteDialogManagerDependencies<C>,
        component: ComponentHasResult<T, U>,
        initialData?: U
    ) {
        super();
        this.initDialog(context, dependents, component, initialData);
    }
}
export class BrowserSvelteDialogManager<T extends ServiceContext> extends SvelteDialogManagerBase<T> {
    override async openSvelteDialog<TT, TU>(
        component: ComponentHasResult<TT, TU>,
        initialData?: TU
    ): Promise<TT | undefined> {
        const dialog = new SvelteDialogBrowser<TT, TU, T>(this.context, this.dependents, component, initialData);
        dialog.open();
        return await dialog.waitForClose();
    }
}
