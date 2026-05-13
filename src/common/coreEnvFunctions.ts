// This module provides core environment functions that can be set by the
// host application (like Obsidian) and used across the library without
// direct dependencies on the host's APIs.
// For `features`, please implement service, feature, or, serviceFeature for the sake of
// robust architecture and dependency management. Only put truly core functions here that.

// Do not import `obsidian`, especially, that because this function is used in every platform.
import type { getLanguage as ObsidianGetLanguage } from "obsidian";

let _getLanguage: typeof ObsidianGetLanguage = () => "en";

export function setGetLanguage(func: typeof ObsidianGetLanguage) {
    _getLanguage = func;
}

export function getLanguage() {
    return _getLanguage();
}
