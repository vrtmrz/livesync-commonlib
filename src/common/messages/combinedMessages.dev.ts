import { PartialMessages as def } from "./def.ts";
import { PartialMessages as es } from "./es.ts";
import { PartialMessages as ja } from "./ja.ts";
import { PartialMessages as ko } from "./ko.ts";
import { PartialMessages as ru } from "./ru.ts";
import { PartialMessages as zh } from "./zh.ts";
import { PartialMessages as zhTw } from "./zh-tw.ts";

// Flatten a PartialMessages object (merge all page JSONs into one)
function flattenPartialMessages(partial: Record<string, Record<string, string>>) {
    const flat: Record<string, string> = {};
    for (const pageKey in partial) {
        Object.assign(flat, partial[pageKey]);
    }
    return flat;
}

// Flatten each locale
const defFlat = flattenPartialMessages(def);
const esFlat = flattenPartialMessages(es);
const jaFlat = flattenPartialMessages(ja);
const koFlat = flattenPartialMessages(ko);
const ruFlat = flattenPartialMessages(ru);
const zhFlat = flattenPartialMessages(zh);
const zhTwFlat = flattenPartialMessages(zhTw);

// Union of all keys from the English (def) locale
export type MessageKeys = keyof typeof defFlat;

// Merge all locales into _allMessages
export const _allMessages: Record<MessageKeys, Record<string, string>> = {} as any;

for (const key of Object.keys(defFlat)) {
    _allMessages[key] = {
        def: defFlat[key],
        es: esFlat[key],
        ja: jaFlat[key],
        ko: koFlat[key],
        ru: ruFlat[key],
        zh: zhFlat[key],
        zhTw: zhTwFlat[key],
    };
}
