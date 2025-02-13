import { PartialMessages as def } from "./def";
import { PartialMessages as es } from "./es";
import { PartialMessages as ja } from "./ja";
import { PartialMessages as ru } from "./ru";
import { PartialMessages as zh } from "./zh";
import { PartialMessages as zhTw } from "./zh-tw";

type MessageKeys = keyof typeof def.def;

const messages = {
    ...def,
    ...es,
    ...ja,
    ...ru,
    ...zh,
    ...zhTw,
};
const w = Object.entries(messages)
    .map(([lang, messageDefs]) =>
        Object.entries(messageDefs).map(([key, value]) => [key, [lang, value] as [string, string]] as const)
    )
    .flat();

const _allMessages = w.reduce(
    (acc, [key, value]) => {
        if (!acc[key]) acc[key] = {};
        acc[key][value[0]] = value[1];
        return acc;
    },
    {} as Record<string, Record<string, string>>
) as Record<MessageKeys, { [key: string]: string }>;

export { _allMessages, type MessageKeys };
