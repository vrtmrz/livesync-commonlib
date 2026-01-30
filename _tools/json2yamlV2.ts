import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname, basename, extname } from "node:path";
import { stringify } from "yaml";
import { glob } from "glob";
import { dottedToObject } from "./messagelib";

const currentDir = import.meta.dirname || dirname(new URL(import.meta.url).pathname);
function sortObjectKeys(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(obj).sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
  );
}

async function main() {
  try {
    const srcDir = resolve(currentDir, "../src/common/messagesJson");
    console.log(`Target Input Directory: ${srcDir}`);
    const files = await glob(join(srcDir, "*.json").replace(/\\/g, "/"));
    if (files.length === 0) {
      console.warn("No JSON files found.");
      return;
    }
    console.log(`found ${files.length} files.`);
    for (const file of files) {
      const inputPath = resolve(file);
      try {
        const fileName = basename(inputPath, extname(inputPath));
        const outputDir = srcDir.replace("messagesJson", "messagesYAML");
        const outputPath = join(outputDir, `${fileName}.yaml`);
        await mkdir(dirname(outputPath), { recursive: true });
        console.log(`Processing: ${basename(inputPath)}...`);
        const content = await readFile(inputPath, "utf-8");
        const jsonDataSrc = JSON.parse(content);
        const sortedJsonData = sortObjectKeys(jsonDataSrc);
        const nestedData = dottedToObject(sortedJsonData);
        const yamlData = stringify(nestedData, { indent: 2 });
        await writeFile(outputPath, yamlData, "utf-8");
        console.log(`Converted: ${basename(outputPath)}`);

      } catch (fileError) {
        console.error(`Failed to process file: ${inputPath}`, fileError);
      }
    }
    console.log("\nAll conversions completed.");
  } catch (error) {
    console.error("Fatal Error:", error);
    process.exit(1);
  }
}

main();