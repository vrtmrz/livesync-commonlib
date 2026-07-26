export type ConfirmActionLayout = "auto" | "vertical";

export interface Confirm {
    askYesNo(message: string): Promise<"yes" | "no">;
    askString(title: string, key: string, placeholder: string, isPassword?: boolean): Promise<string | false>;

    askYesNoDialog(
        message: string,
        opt: { title?: string; defaultOption?: "Yes" | "No"; timeout?: number }
    ): Promise<"yes" | "no">;

    askSelectString(message: string, items: string[]): Promise<string>;

    askSelectStringDialogue<T extends readonly string[]>(
        message: string,
        buttons: T,
        opt: { title?: string; defaultAction: T[number]; timeout?: number }
    ): Promise<T[number] | false>;

    /**
     * Shows a non-blocking message containing one host-rendered action link.
     *
     * Hosts which can display transient UI should keep the message visible for
     * `durationMs`. Headless hosts may report the message without presenting an
     * interactive action.
     */
    askInPopup(
        key: string,
        dialogText: string,
        anchorCallback: (anchor: HTMLAnchorElement) => void,
        durationMs?: number
    ): void;

    confirmWithMessage(
        title: string,
        contentMd: string,
        buttons: string[],
        defaultAction: (typeof buttons)[number],
        timeout?: number,
        actionLayout?: ConfirmActionLayout
    ): Promise<(typeof buttons)[number] | false>;
}
