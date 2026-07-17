import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { IAPIService, ICommandCompat } from "@lib/services/base/IService";
import { handlers } from "@lib/services/lib/HandlerUtils";
import type { Confirm } from "@lib/interfaces/Confirm";
import { BrowserConfirm } from "./BrowserConfirm";
import { LOG_LEVEL_VERBOSE } from "@lib/common/logger";
import { _activeDocument } from "@lib/common/coreEnvFunctions.ts";

export declare const PACKAGE_VERSION: string;
export declare const MANIFEST_VERSION: string;

export class BrowserAPIService<T extends ServiceContext> extends InjectableAPIService<T> {
    _confirmInstance: Confirm;
    private commandBar: HTMLDivElement | null = null;
    private commandButtons = new Map<string, HTMLButtonElement>();
    private logPanel: HTMLDivElement | null = null;
    private logViewport: HTMLDivElement | null = null;
    private readonly maxLogLines = 300;
    private windowFactories = new Map<string, (leaf: any) => any>();
    private windowInstances = new Map<string, any>();
    private windowRoot: HTMLDivElement | null = null;
    private windowTabs: HTMLDivElement | null = null;
    private windowBody: HTMLDivElement | null = null;
    private windowPanels = new Map<string, HTMLDivElement>();
    private activeWindowType: string | null = null;

    constructor(context: T) {
        super(context);
        this._confirmInstance = new BrowserConfirm(context);
        this.addLog.setHandler((message, level, key) => {
            if (level >= LOG_LEVEL_VERBOSE) {
                this.appendLog(message, level, key);
            }
        });
    }
    get confirm(): Confirm {
        return this._confirmInstance;
    }

    async showWindow(type: string): Promise<void> {
        const factory = this.windowFactories.get(type);
        if (!factory) {
            this.appendLog(`Window type is not registered: ${type}`, "warn", "showWindow");
            return;
        }

        this.ensureWindowHost();
        const panel = this.ensureWindowPanel(type);
        this.activateWindow(type);

        if (!this.windowInstances.has(type)) {
            panel.replaceChildren();

            const leaf = this.createLeafShim(type, panel);
            const view = factory(leaf);
            this.windowInstances.set(type, view);

            if (view instanceof HTMLElement) {
                panel.appendChild(view);
            }

            if (view && typeof view.onOpen === "function") {
                await Promise.resolve(view.onOpen());
            }
        }
    }
    getCustomFetchHandler(): FetchHttpHandler {
        return undefined!;
    }
    isMobile(): boolean {
        return false;
    }
    getAppID(): string {
        return "browser-app";
    }
    getSystemVaultName = handlers<IAPIService>().binder("getSystemVaultName");
    getAppVersion(): string {
        return `${MANIFEST_VERSION ?? "0.0.0."}`;
    }
    getPluginVersion(): string {
        return `${MANIFEST_VERSION ?? "0.0.0."}`;
    }
    override getPlatform(): string {
        return "browser";
    }
    override getCrypto(): Crypto {
        return globalThis.crypto;
    }

    override nativeFetch(req: string | Request, opts?: RequestInit): Promise<Response> {
        return fetch(req, opts);
    }

    private ensureLogPanel(): HTMLDivElement {
        if (this.logPanel && _activeDocument.body.contains(this.logPanel)) {
            return this.logPanel;
        }

        let panel = _activeDocument.getElementById("livesync-log-panel") as HTMLDivElement | null;
        let viewport = _activeDocument.getElementById("livesync-log-viewport") as HTMLDivElement | null;

        if (!panel) {
            // Very sample log panel implementation, just for development and debugging purpose. It will be improved later, and maybe even support some features like log level filtering.
            panel = _activeDocument.createElement("div");
            panel.id = "livesync-log-panel";

            const header = _activeDocument.createElement("div");
            header.textContent = "LiveSync Logs";
            header.className = "livesync-log-header";

            viewport = _activeDocument.createElement("div");
            viewport.id = "livesync-log-viewport";

            panel.appendChild(header);
            panel.appendChild(viewport);
            _activeDocument.body.appendChild(panel);
        }

        _activeDocument.body.classList.add("livesync-log-visible");

        this.logPanel = panel;
        this.logViewport = viewport;
        return panel;
    }

    private formatLogLine(message: any, level: any, key?: string): string {
        let body: string;
        if (typeof message === "string") {
            body = message;
        } else if (message instanceof Error) {
            body = message.stack ?? message.message;
        } else {
            try {
                body = JSON.stringify(message);
            } catch {
                body = String(message);
            }
        }

        const timestamp = new Date().toLocaleTimeString();
        const levelLabel = level === undefined || level === null ? "LOG" : String(level);
        const keyLabel = key ? ` [${key}]` : "";
        return `${timestamp} [${levelLabel}]${keyLabel} ${body}`;
    }

    private appendLog(message: any, level: any, key?: string): void {
        this.ensureLogPanel();
        if (!this.logViewport) {
            return;
        }

        const line = _activeDocument.createElement("div");
        line.textContent = this.formatLogLine(message, level, key);
        line.className = "livesync-log-line";

        this.logViewport.appendChild(line);

        while (this.logViewport.childElementCount > this.maxLogLines) {
            this.logViewport.removeChild(this.logViewport.firstElementChild!);
        }

        this.logViewport.scrollTop = this.logViewport.scrollHeight;
    }

    private ensureCommandBar(): HTMLDivElement {
        if (this.commandBar && _activeDocument.body.contains(this.commandBar)) {
            return this.commandBar;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        let host = _activeDocument.getElementById("livesync-command-bar") as HTMLDivElement | null;
        if (!host) {
            host = _activeDocument.createElement("div");
            host.id = "livesync-command-bar";
            _activeDocument.body.appendChild(host);
        }

        this.commandBar = host;
        return host;
    }

    private ensureWindowHost(): HTMLDivElement {
        if (this.windowRoot && _activeDocument.body.contains(this.windowRoot)) {
            return this.windowRoot;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        let root = _activeDocument.getElementById("livesync-window-root") as HTMLDivElement | null;
        if (!root) {
            root = _activeDocument.createElement("div");
            root.id = "livesync-window-root";

            const tabs = _activeDocument.createElement("div");
            tabs.id = "livesync-window-tabs";

            const body = _activeDocument.createElement("div");
            body.id = "livesync-window-body";

            root.appendChild(tabs);
            root.appendChild(body);
            _activeDocument.body.appendChild(root);
        }

        this.windowRoot = root;
        this.windowTabs = _activeDocument.getElementById("livesync-window-tabs") as HTMLDivElement;
        this.windowBody = _activeDocument.getElementById("livesync-window-body") as HTMLDivElement;
        return root;
    }

    private ensureWindowTab(type: string): HTMLButtonElement {
        this.ensureWindowHost();
        const existing = this.windowTabs!.querySelector<HTMLButtonElement>(`[data-window-tab="${type}"]`);
        if (existing) {
            return existing;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        const tab = _activeDocument.createElement("button");
        tab.type = "button";
        tab.dataset.windowTab = type;
        tab.textContent = type;
        tab.className = "livesync-window-tab";
        tab.onclick = () => {
            void this.showWindow(type);
        };
        this.windowTabs!.appendChild(tab);
        return tab;
    }

    private ensureWindowPanel(type: string): HTMLDivElement {
        this.ensureWindowHost();

        const existing = this.windowPanels.get(type);
        if (existing) {
            return existing;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        const panel = _activeDocument.createElement("div");
        panel.dataset.windowPanel = type;
        panel.className = "livesync-window-panel";

        this.windowBody!.appendChild(panel);
        this.windowPanels.set(type, panel);
        this.ensureWindowTab(type);
        return panel;
    }

    private activateWindow(type: string): void {
        this.activeWindowType = type;
        for (const [windowType, panel] of this.windowPanels.entries()) {
            panel.classList.toggle("is-active", windowType === type);
        }

        this.windowTabs?.querySelectorAll<HTMLButtonElement>("button[data-window-tab]").forEach((tab) => {
            const isActive = tab.dataset.windowTab === type;
            tab.classList.toggle("is-active", isActive);
        });
    }

    private createLeafShim(type: string, panel: HTMLDivElement): any {
        return {
            type,
            containerEl: panel,
            view: undefined,
            setViewState: async (state: any) => {
                if (state?.type && state.type !== type) {
                    await this.showWindow(state.type);
                }
            },
        };
    }

    private evaluateEnabled(command: ICommandCompat): boolean {
        if (command.checkCallback) {
            try {
                return command.checkCallback(true) === true;
            } catch {
                return false;
            }
        }
        return true;
    }

    private executeCommand(command: ICommandCompat): void {
        const enabled = this.evaluateEnabled(command);
        if (!enabled) {
            console.warn(`[BrowserAPIService] Command is not enabled: ${command.id}`);
            return;
        }
        try {
            if (command.checkCallback) {
                const canRun = command.checkCallback(false);
                if (canRun === false) {
                    return;
                }
            }

            if (command.callback) {
                void Promise.resolve(command.callback()).catch((error) => {
                    console.error(`[BrowserAPIService] Command failed: ${command.id}`, error);
                });
            }
        } catch (error) {
            console.error(`[BrowserAPIService] Command failed: ${command.id}`, error);
        }
    }

    private refreshCommandStates(): void {
        for (const [id, button] of this.commandButtons.entries()) {
            const command = (button as any).__command as ICommandCompat | undefined;
            if (!command) {
                continue;
            }
            const enabled = this.evaluateEnabled(command);
            button.disabled = !enabled;
            button.classList.toggle("is-disabled", !enabled);
            if (!enabled && !button.title) {
                button.title = id;
            }
        }
    }

    addCommand<TCommand extends ICommandCompat>(command: TCommand): TCommand {
        const bar = this.ensureCommandBar();
        const key = command.id || command.name;
        let button = this.commandButtons.get(key);

        if (!button) {
            button = _activeDocument.createElement("button");
            button.type = "button";
            button.className = "livesync-command-button";
            bar.appendChild(button);
            this.commandButtons.set(key, button);
        }

        button.textContent = command.name || command.id;
        button.title = command.id;
        (button as any).__command = command;
        button.onclick = () => this.executeCommand(command);

        // queueMicrotask(() => this.refreshCommandStates());

        return command;
    }
    addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
        return _activeDocument.createElement("div");
    }
    registerWindow(type: string, factory: (leaf: any) => any): void {
        this.windowFactories.set(type, factory);
        this.ensureWindowPanel(type);
    }
    registerProtocolHandler(action: string, handler: (params: Record<string, string>) => any): void {
        // In a browser environment, protocol handler registration might not be applicable.
    }
    addStatusBarItem(): HTMLElement | undefined {
        // In a browser environment, status bar item might not be applicable.
        return undefined;
    }
}
