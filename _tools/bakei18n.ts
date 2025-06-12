import { writeFileSync } from "fs";
import { _allMessages } from "../src/common/messages/combinedMessages.dev.ts";
import path from "path";
const __dirname = import.meta.dirname;
const currentPath = __dirname;
const outDir = path.resolve(currentPath, "../src/common/messages/combinedMessages.prod.ts");

console.log(`Writing to ${outDir}`);
writeFileSync(outDir, `export const _allMessages = ${JSON.stringify(_allMessages, null, 4)} as const;`);
