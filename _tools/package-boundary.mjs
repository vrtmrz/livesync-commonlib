import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const productionExtensions = [".ts", ".svelte"];
const testFilePattern = /(?:\.unit)?\.(?:spec|test)\.ts$/u;
const importPatterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

async function collectFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await collectFiles(path)));
        else if (
            entry.isFile() &&
            productionExtensions.some((extension) => entry.name.endsWith(extension)) &&
            !testFilePattern.test(entry.name)
        ) {
            files.push(path);
        }
    }
    return files;
}

export function isForbiddenPackageImport(specifier) {
    return specifier === "obsidian" || specifier.startsWith("obsidian/") || specifier.startsWith("@/");
}

function stripComments(source) {
    let result = "";
    let state = "code";
    let quote = "";
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (state === "code") {
            if (character === "/" && next === "/") {
                result += "  ";
                index += 1;
                state = "line-comment";
            } else if (character === "/" && next === "*") {
                result += "  ";
                index += 1;
                state = "block-comment";
            } else {
                result += character;
                if (character === '"' || character === "'" || character === "`") {
                    quote = character;
                    state = "string";
                }
            }
        } else if (state === "string") {
            result += character;
            if (character === "\\") {
                result += next ?? "";
                index += 1;
            } else if (character === quote) {
                state = "code";
            }
        } else if (state === "line-comment") {
            if (character === "\n") {
                result += character;
                state = "code";
            } else {
                result += " ";
            }
        } else if (character === "*" && next === "/") {
            result += "  ";
            index += 1;
            state = "code";
        } else {
            result += character === "\n" ? "\n" : " ";
        }
    }
    return result;
}

export function extractImportSpecifiers(source) {
    const uncommented = stripComments(source);
    const specifiers = new Set();
    for (const pattern of importPatterns) {
        pattern.lastIndex = 0;
        for (const match of uncommented.matchAll(pattern)) specifiers.add(match[1]);
    }
    return [...specifiers].sort();
}

/**
 * Package modules must not patch DOM prototypes when they are imported.
 * Keeping prototype access out of production source makes this boundary easy to audit.
 */
export function hasForbiddenDomPrototypeAccess(source) {
    const uncommented = stripComments(source);
    return /\b(?:HTMLElement|SVGElement)\s*\.\s*prototype\b/u.test(uncommented);
}

export async function collectBoundaryFindings(root) {
    const sourceRoot = resolve(root, "src");
    const findings = [];
    for (const path of await collectFiles(sourceRoot)) {
        const source = await readFile(path, "utf8");
        for (const specifier of extractImportSpecifiers(source)) {
            if (!isForbiddenPackageImport(specifier)) continue;
            findings.push({
                file: relative(root, path).split(sep).join("/"),
                specifier,
            });
        }
    }
    return findings.sort((left, right) =>
        `${left.file}\0${left.specifier}`.localeCompare(`${right.file}\0${right.specifier}`)
    );
}

export async function collectDomPrototypeFindings(root) {
    const sourceRoot = resolve(root, "src");
    const findings = [];
    for (const path of await collectFiles(sourceRoot)) {
        const source = await readFile(path, "utf8");
        if (hasForbiddenDomPrototypeAccess(source)) {
            findings.push(relative(root, path).split(sep).join("/"));
        }
    }
    return findings.sort();
}
