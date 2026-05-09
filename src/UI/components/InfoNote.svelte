<script lang="ts">
    import { translateIfAvailable } from "@lib/common/i18n";
    type Props = {
        title?: string;
        message?: string;
        children?: () => any;
        cssClass?: string;
        warning?: boolean;
        error?: boolean;
        info?: boolean;
        visible?: boolean;
    };
    const {
        title,
        message,
        children,
        cssClass,
        warning: isWarning,
        error: isError,
        info: isInfo = true,
        visible,
    }: Props = $props();
    const derivedCssClass = $derived.by(() => {
        if (isError) {
            return "note-error";
        } else if (isWarning) {
            return "note-important";
        } else if (isInfo) {
            return "note";
        } else {
            return "";
        }
    });
    const displayTitle = $derived.by(() => (title ? translateIfAvailable(title) : ""));
    const displayMessage = $derived.by(() => (message ? translateIfAvailable(message) : ""));
</script>

{#if visible === undefined || visible === true}
    <div class={(cssClass ?? "") + " " + derivedCssClass}>
        {#if displayTitle}<h3>{displayTitle}</h3>{/if}
        {#if displayMessage}<p>{displayMessage}</p>{/if}
        {@render children?.()}
    </div>
{/if}
