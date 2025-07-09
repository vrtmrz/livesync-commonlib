// Convert Human-Editable format (YAML) to Application convenient Message Resources (JSON)

import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { parse } from "yaml";
import { glob } from "glob";
import { objectToDotted } from "./messagelib";
const __dirname = import.meta.dirname;

const targetDir = resolve(join(__dirname, "../src/common/messagesYAML/"));
console.log(`Target directory: ${targetDir}`);
const files = await glob(`${targetDir}/*.yaml`);
for (const file of files) {
    const filePath = resolve(file);
    console.log(`Processing file: ${filePath}`);
    const content = await readFile(filePath, "utf-8");
    const jsonDataSrc = parse(content);
    const jsonDataD2 = objectToDotted(jsonDataSrc);
    const jsonData = Object.fromEntries(
        Object.entries(jsonDataD2)
            .map(([key, value]) => [key.endsWith("._value") ? key.slice(0, -7) : key, value] as [string, any])
            .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    );
    const yamlData = JSON.stringify(jsonData, null, 2);
    const yamlFilePath = filePath.replace(/\.yaml$/, ".json").replace("YAML", "Json");
    await writeFile(yamlFilePath, yamlData, "utf-8");
    console.log(`Converted ${filePath} to ${yamlFilePath}`);
}

// console.dir(files, { depth: 0 });
