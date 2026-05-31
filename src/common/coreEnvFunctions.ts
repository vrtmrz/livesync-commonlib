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

// Compatibility for globalThis across different environments (browser, Node.js, etc.)
export const compatGlobal = (
    typeof window !== "undefined"
        ? window
        : // compatibility for CLIs, tests, and other non-browser environments.
          // eslint-disable-next-line obsidianmd/no-global-this
          globalThis
) as typeof window;

/**
 * A wrapper around the global fetch function to ensure compatibility across different environments.
 * In Obsidian, they recommend using their own requestUrl for better performance and reliability.
 * However, at least for now, requestUrl cannot handle multiple concurrent requests, which causes
 * problems for synchronise lively. So we will use the global fetch for now.
 * If the situation changes in the future, change this function to use requestUrl.
 * @param {RequestInfo} input  The resource that you wish to fetch. Can be either a string or a Request object.
 * @param {RequestInit} [init] An options object containing any custom settings that you want to apply to the request.
 * @returns {Promise<Response>} A Promise that resolves to the Response to that request, whether it is successful or not.
 */
export const _fetch = compatGlobal.fetch.bind(compatGlobal);
