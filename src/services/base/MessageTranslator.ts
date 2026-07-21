import { commonlibEnglishMessages, type CommonlibMessageKey } from "@lib/services/base/CommonlibMessages";

/** Placeholder values substituted by a host translator. */
export type TranslationParameters = Readonly<Record<string, string>>;

/** A message translator supplied by the host for one service context. */
export type MessageTranslator<TKey extends string = CommonlibMessageKey> = (
    key: TKey,
    params?: TranslationParameters
) => string;

function resolveEnglishMessage(key: string, seen = new Set<string>()): string {
    if (seen.has(key)) return key;
    seen.add(key);
    const message = commonlibEnglishMessages[key as CommonlibMessageKey] ?? key;
    return message.replace(/%\{([^}]+)\}/g, (_token, referencedKey: string) => {
        const directKey = referencedKey as CommonlibMessageKey;
        const keywordKey = `K.${referencedKey}` as CommonlibMessageKey;
        if (directKey in commonlibEnglishMessages) return resolveEnglishMessage(directKey, new Set(seen));
        if (keywordKey in commonlibEnglishMessages) return resolveEnglishMessage(keywordKey, new Set(seen));
        return `%{${referencedKey}}`;
    });
}

/** Default translator which renders Commonlib's canonical English messages. */
export const englishMessageTranslator: MessageTranslator = (key, params = {}) => {
    let message = resolveEnglishMessage(key);
    for (const [placeholder, value] of Object.entries(params)) {
        message = message.replaceAll(`\${${placeholder}}`, value);
    }
    return message;
};

/** Compatibility translator for hosts which intentionally render raw message keys. */
export const passthroughMessageTranslator: MessageTranslator = (key) => key;
