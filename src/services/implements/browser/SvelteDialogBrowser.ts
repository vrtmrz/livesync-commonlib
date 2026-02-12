import { type ComponentHasResult, SvelteDialogManagerBase, SvelteDialogMixIn } from "../base/SvelteDialog.ts";
import type { ServiceContext } from "@lib/services/base/ServiceBase.ts";
import type { SvelteDialogManagerDependencies } from "../base/SvelteDialog";
import DialogHost from "@/lib/src/UI/DialogHost.svelte";
export type DialogMessageProps = Record<string, any>;

export class ShimModal {
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;
    isOpen: boolean = false;

    constructor() {
        this.contentEl = document.createElement("div");
        this.contentEl.className = "modal-content";
        this.titleEl = document.createElement("div");
        this.titleEl.className = "modal-title";
        this.modalEl = document.createElement("div");
        this.modalEl.className = "modal";
        this.modalEl.style.display = "none";
        this.modalEl.appendChild(this.titleEl);
        this.modalEl.appendChild(this.contentEl);
    }
    open() {
        this.isOpen = true;
        this.modalEl.style.display = "block";
        if (!this.modalEl.parentElement) {
            document.body.appendChild(this.modalEl);
        }
        this.onOpen();
    }
    close() {
        this.isOpen = false;
        this.modalEl.style.display = "none";
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
