// Avoid using Obsidian's native function for CLIs.
import { getLanguage } from "./coreEnvFunctions";
import type { AllMessageKeys, I18N_LANGS } from "./rosetta";
import { allMessages } from "./messages/combinedMessages.dev.ts";
import type { TaggedType } from "./types";

const obsidianLangMap: Record<string, I18N_LANGS> = {
    de: "de",
    es: "es",
    ja: "ja",
    ko: "ko",
    ru: "ru",
    zh: "zh",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-tw": "zh-tw",
    "zh-hk": "zh-tw",
    "zh-mo": "zh-tw",
    "zh-hant": "zh-tw",
};

function resolveLanguage(lang: I18N_LANGS): I18N_LANGS {
    if (lang !== "") return lang;
    const obsidianLanguage = getLanguage().toLowerCase();
    return obsidianLangMap[obsidianLanguage] ?? "def";
}

export let currentLang: I18N_LANGS = resolveLanguage("");
const missingTranslations = [] as string[];
let __onMissingTranslations = (key: string) => console.warn(key);
const msgCache = new Map<string, string>();

export function getResolvedLang(lang: I18N_LANGS = currentLang): I18N_LANGS {
    return resolveLanguage(lang);
}

export function isAutoDisplayLanguage(lang: I18N_LANGS): boolean {
    return lang === "";
}

export function __getMissingTranslations() {
    return missingTranslations;
}

export function __onMissingTranslation(callback: (key: string) => void) {
    __onMissingTranslations = callback;
}

export function setLang(lang: I18N_LANGS) {
    const resolvedLang = resolveLanguage(lang);
    if (resolvedLang === currentLang) return;
    currentLang = resolvedLang;
    msgCache.clear();
}

function _getMessage(key: string, lang: I18N_LANGS) {
    if (key.trim() == "") return key;

    const msgs = allMessages[key] ?? undefined;
    const resolvedLang = resolveLanguage(lang);
    let msg = msgs?.[resolvedLang];

    if (!msg) {
        if (missingTranslations.indexOf(key) === -1) {
            __onMissingTranslations(key);
            missingTranslations.push(key);
        }
        msg = msgs?.def;
    }
    return msg ?? key;
}

function getMessage(key: string) {
    if (msgCache.has(key)) return msgCache.get(key) as string;
    const msg = _getMessage(key, currentLang);
    msgCache.set(key, msg);
    return msg;
}

export function $t(message: string, lang?: I18N_LANGS) {
    if (lang !== undefined) {
        return _getMessage(message, lang);
    }
    return getMessage(message);
}

export function translateIfAvailable(message: string, lang?: I18N_LANGS) {
    if (message.trim() == "" || allMessages[message] === undefined) return message;
    return $t(message, lang);
}

/**
 * TagFunction to Automatically translate.
 * @param strings
 * @param values
 * @returns
 */
export function $f(strings: TemplateStringsArray, ...values: string[]) {
    let result = "";
    for (let i = 0; i < values.length; i++) {
        result += getMessage(strings[i]) + values[i];
    }
    result += getMessage(strings[strings.length - 1]);
    return result;
}

export function $msg<T extends AllMessageKeys>(
    key: T,
    params: Record<string, string> = {},
    lang?: I18N_LANGS
): TaggedType<string, T> {
    let msg = $t(key, lang);
    for (const [placeholder, value] of Object.entries(params)) {
        const regex = new RegExp(`\\\${${placeholder}}`, "g");
        msg = msg.replace(regex, value);
    }
    return msg as TaggedType<string, T>;
}
