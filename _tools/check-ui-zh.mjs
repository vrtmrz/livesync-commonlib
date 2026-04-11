import { readFileSync } from "node:fs";

const files = [
    "src/modules/features/SettingDialogue/PaneHatch.ts",
    "src/modules/features/SettingDialogue/PaneMaintenance.ts",
    "src/modules/features/SettingDialogue/PaneRemoteConfig.ts",
    "src/modules/features/SettingDialogue/PanePatches.ts",
];

const pattern =
    /(setName|setDesc|setButtonText|appendText|setTitle|promptCopyToClipboard|askString|askYesNoDialog)\(".*[A-Za-z].*"\)/;

let hasFinding = false;

for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
        if (line.trimStart().startsWith("//")) return;
        if (pattern.test(line)) {
            hasFinding = true;
            console.log(`${file}:${index + 1}:${line.trim()}`);
        }
    });
}

if (hasFinding) {
    process.exitCode = 1;
} else {
    console.log("No direct English UI string patterns found in targeted panes.");
}
