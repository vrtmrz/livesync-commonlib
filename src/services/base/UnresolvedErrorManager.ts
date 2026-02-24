import { eventHub, EVENT_ON_UNRESOLVED_ERROR } from "@/common/events";
import { type LOG_LEVEL, LEVEL_NOTICE, LEVEL_INFO } from "octagonal-wheels/common/logger";
import { createInstanceLogFunction } from "../lib/logUtils";
import type { AppLifecycleService } from "./AppLifecycleService";

export class UnresolvedErrorManager {
    private _log = createInstanceLogFunction("UnresolvedErrorManager");
    private appLifecycleService: AppLifecycleService;
    private _occurredErrors = new Set<string>();
    showError(msg: string, max_log_level: LOG_LEVEL = LEVEL_NOTICE) {
        // If the error has already occurred, we will only log it as info, to avoid spamming the user with the same error.
        const level = this._occurredErrors.has(msg) ? LEVEL_INFO : max_log_level;
        this._log(msg, level);
        if (!this._occurredErrors.has(msg)) {
            this._occurredErrors.add(msg);
            eventHub.emitEvent(EVENT_ON_UNRESOLVED_ERROR);
        }
    }

    clearError(msg: string) {
        if (!this._occurredErrors.has(msg)) {
            return;
        }
        this._occurredErrors.delete(msg);
        eventHub.emitEvent(EVENT_ON_UNRESOLVED_ERROR);
    }
    clearErrors() {
        this._occurredErrors.clear();
        eventHub.emitEvent(EVENT_ON_UNRESOLVED_ERROR);
    }

    countErrors(needle: string) {
        return Array.from(this._occurredErrors).filter(
            (error) => typeof error === "string" && error.indexOf(needle) !== -1
        ).length;
    }

    private _reportUnresolvedMessages() {
        return Promise.resolve(Array.from(this._occurredErrors));
    }

    constructor(appLifecycleService: AppLifecycleService) {
        this.appLifecycleService = appLifecycleService;
        this.appLifecycleService.getUnresolvedMessages.addHandler(this._reportUnresolvedMessages.bind(this));
    }
}
