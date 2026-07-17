/** Placeholder values substituted by a host translator. */
export type TranslationParameters = Readonly<Record<string, string>>;

/** A message translator supplied by the host for one service context. */
export type MessageTranslator = <TKey extends string>(
    key: TKey,
    params?: TranslationParameters
) => string;

/** Default translator for headless clients which returns the message key unchanged. */
export const passthroughMessageTranslator: MessageTranslator = (key) => key;
