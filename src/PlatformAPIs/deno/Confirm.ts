import type { Confirm } from "../../interfaces/Confirm";
import { setConfirmInstance } from "../Confirm";
import { ServerAPIBase } from "./base";

export { setConfirmInstance, getConfirmInstance } from "../Confirm";

// Stub
class ServerConfirm extends ServerAPIBase implements Confirm {
    askYesNo(message: string): Promise<"yes" | "no"> {
        throw new Error("Method not implemented.");
    }
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false> {
        throw new Error("Method not implemented.");
    }
    askYesNoDialog(
        message: string,
        opt: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no"> {
        throw new Error("Method not implemented.");
    }
    askSelectString(message: string, items: string[]): Promise<string> {
        throw new Error("Method not implemented.");
    }
    askSelectStringDialogue<T extends readonly string[]>(
        message: string,
        buttons: T,
        opt: { title?: string; defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false> {
        throw new Error("Method not implemented.");
    }
    askInPopup(key: string, dialogText: string, anchorCallback: (anchor: HTMLAnchorElement) => void): void {
        throw new Error("Method not implemented.");
    }
    confirmWithMessage(
        title: string,
        contentMd: string,
        buttons: string[],
        defaultAction: (typeof buttons)[number],
        timeout?: number
    ): Promise<(typeof buttons)[number] | false> {
        throw new Error("Method not implemented.");
    }
}

setConfirmInstance(new ServerConfirm());
