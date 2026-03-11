import type { ServiceContext } from "@lib/services/base/ServiceBase";
import { InjectableAPIService } from "@lib/services/implements/injectable/InjectableAPIService";
import type { FetchHttpHandler } from "@smithy/fetch-http-handler";
import type { IAPIService, ICommandCompat } from "../../base/IService";
import { handlers } from "../../lib/HandlerUtils";
import type { Confirm } from "@lib/interfaces/Confirm";
import { BrowserConfirm } from "./BrowserConfirm";
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
            this.appendLog(message, level, key);
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
            panel.innerHTML = "";

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

    private ensureLogPanel(): HTMLDivElement {
        if (this.logPanel && document.body.contains(this.logPanel)) {
            return this.logPanel;
        }

        let panel = document.getElementById("livesync-log-panel") as HTMLDivElement | null;
        let viewport = document.getElementById("livesync-log-viewport") as HTMLDivElement | null;

        if (!panel) {
            // Very sample log panel implementation, just for development and debugging purpose. It will be improved later, and maybe even support some features like log level filtering.
            panel = document.createElement("div");
            panel.id = "livesync-log-panel";
            panel.style.position = "fixed";
            panel.style.left = "0";
            panel.style.right = "0";
            panel.style.bottom = "0";
            panel.style.height = "42vh";
            panel.style.zIndex = "900";
            panel.style.display = "flex";
            panel.style.flexDirection = "column";
            panel.style.background = "#0f172a";
            panel.style.borderTop = "1px solid #334155";

            const header = document.createElement("div");
            header.textContent = "LiveSync Logs";
            header.style.padding = "8px 12px";
            header.style.fontSize = "12px";
            header.style.fontWeight = "600";
            header.style.color = "#e2e8f0";
            header.style.background = "#111827";
            header.style.borderBottom = "1px solid #334155";

            viewport = document.createElement("div");
            viewport.id = "livesync-log-viewport";
            viewport.style.flex = "1";
            viewport.style.overflow = "auto";
            viewport.style.padding = "8px 12px";
            viewport.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
            viewport.style.fontSize = "12px";
            viewport.style.lineHeight = "1.4";
            viewport.style.color = "#e2e8f0";
            viewport.style.whiteSpace = "pre-wrap";
            viewport.style.wordBreak = "break-word";

            panel.appendChild(header);
            panel.appendChild(viewport);
            document.body.appendChild(panel);
        }

        document.body.style.minHeight = "100vh";
        document.body.style.paddingBottom = "42vh";

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

        const line = document.createElement("div");
        line.textContent = this.formatLogLine(message, level, key);
        line.style.marginBottom = "2px";

        this.logViewport.appendChild(line);

        while (this.logViewport.childElementCount > this.maxLogLines) {
            this.logViewport.removeChild(this.logViewport.firstElementChild!);
        }

        this.logViewport.scrollTop = this.logViewport.scrollHeight;
    }

    private ensureCommandBar(): HTMLDivElement {
        if (this.commandBar && document.body.contains(this.commandBar)) {
            return this.commandBar;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        let host = document.getElementById("livesync-command-bar") as HTMLDivElement | null;
        if (!host) {
            host = document.createElement("div");
            host.id = "livesync-command-bar";
            host.style.position = "fixed";
            host.style.right = "16px";
            host.style.bottom = "16px";
            host.style.zIndex = "1000";
            host.style.display = "flex";
            host.style.flexWrap = "wrap";
            host.style.gap = "8px";
            host.style.maxWidth = "40vw";
            host.style.padding = "10px";
            host.style.borderRadius = "10px";
            host.style.background = "rgba(255,255,255,0.95)";
            host.style.boxShadow = "0 4px 16px rgba(0,0,0,0.2)";
            document.body.appendChild(host);
        }

        this.commandBar = host;
        return host;
    }

    private ensureWindowHost(): HTMLDivElement {
        if (this.windowRoot && document.body.contains(this.windowRoot)) {
            return this.windowRoot;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        let root = document.getElementById("livesync-window-root") as HTMLDivElement | null;
        if (!root) {
            root = document.createElement("div");
            root.id = "livesync-window-root";
            root.style.position = "fixed";
            root.style.top = "16px";
            root.style.left = "16px";
            root.style.right = "16px";
            root.style.bottom = "calc(42vh + 16px)";
            root.style.zIndex = "850";
            root.style.display = "flex";
            root.style.flexDirection = "column";
            root.style.borderRadius = "10px";
            root.style.background = "rgba(255,255,255,0.98)";
            root.style.boxShadow = "0 4px 16px rgba(0,0,0,0.18)";
            root.style.overflow = "hidden";

            const tabs = document.createElement("div");
            tabs.id = "livesync-window-tabs";
            tabs.style.display = "flex";
            tabs.style.gap = "6px";
            tabs.style.padding = "8px";
            tabs.style.background = "#f3f4f6";
            tabs.style.borderBottom = "1px solid #e5e7eb";

            const body = document.createElement("div");
            body.id = "livesync-window-body";
            body.style.position = "relative";
            body.style.flex = "1";
            body.style.overflow = "auto";
            body.style.padding = "10px";

            root.appendChild(tabs);
            root.appendChild(body);
            document.body.appendChild(root);
        }

        this.windowRoot = root;
        this.windowTabs = document.getElementById("livesync-window-tabs") as HTMLDivElement;
        this.windowBody = document.getElementById("livesync-window-body") as HTMLDivElement;
        return root;
    }

    private ensureWindowTab(type: string): HTMLButtonElement {
        this.ensureWindowHost();
        const existing = this.windowTabs!.querySelector<HTMLButtonElement>(`[data-window-tab="${type}"]`);
        if (existing) {
            return existing;
        }
        // Very sample implementation, just for development and debugging purpose. It will be improved later.
        const tab = document.createElement("button");
        tab.type = "button";
        tab.dataset.windowTab = type;
        tab.textContent = type;
        tab.style.border = "1px solid #d1d5db";
        tab.style.background = "#fff";
        tab.style.padding = "4px 8px";
        tab.style.borderRadius = "6px";
        tab.style.cursor = "pointer";
        tab.style.fontSize = "12px";
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
        const panel = document.createElement("div");
        panel.dataset.windowPanel = type;
        panel.style.display = "none";
        panel.style.width = "100%";
        panel.style.height = "100%";
        panel.style.overflow = "auto";

        this.windowBody!.appendChild(panel);
        this.windowPanels.set(type, panel);
        this.ensureWindowTab(type);
        return panel;
    }

    private activateWindow(type: string): void {
        this.activeWindowType = type;
        for (const [windowType, panel] of this.windowPanels.entries()) {
            panel.style.display = windowType === type ? "block" : "none";
        }

        const tabs = this.windowTabs?.querySelectorAll("button[data-window-tab]") ?? [];
        tabs.forEach((tab) => {
            const isActive = (tab as HTMLButtonElement).dataset.windowTab === type;
            (tab as HTMLButtonElement).style.background = isActive ? "#e0e7ff" : "#fff";
            (tab as HTMLButtonElement).style.borderColor = isActive ? "#818cf8" : "#d1d5db";
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
            button.style.opacity = enabled ? "1" : "0.55";
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
            button = document.createElement("button");
            button.type = "button";
            button.style.border = "1px solid #ddd";
            button.style.borderRadius = "8px";
            button.style.padding = "6px 10px";
            button.style.background = "#fff";
            button.style.cursor = "pointer";
            button.style.fontSize = "12px";
            button.style.lineHeight = "1.2";
            button.style.whiteSpace = "nowrap";
            button.onmouseenter = () => {
                if (!button!.disabled) {
                    button!.style.background = "#f3f4f6";
                }
            };
            button.onmouseleave = () => {
                button!.style.background = "#fff";
            };
            bar.appendChild(button);
            this.commandButtons.set(key, button);
        }

        button.textContent = command.name || command.id;
        button.title = command.id;
        (button as any).__command = command;
        button.onclick = () => this.executeCommand(command);

        const enabled = this.evaluateEnabled(command);
        button.disabled = !enabled;
        button.style.opacity = enabled ? "1" : "0.55";

        queueMicrotask(() => this.refreshCommandStates());

        return command;
    }
    addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
        return document.createElement("div");
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
