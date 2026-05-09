<script lang="ts">
    import { translateIfAvailable } from "@lib/common/i18n";

    type Props = {
        children?: () => any;
        important?: boolean;
        title?: string;
        message?: string;
    };
    const { children, important, title, message }: Props = $props();
    const cssClass = $derived.by(() => {
        return important ? "guidance important" : "guidance";
    });
    const translatedTitle = $derived.by(() => (title ? translateIfAvailable(title) : ""));
    const translatedMessage = $derived.by(() => (message ? translateIfAvailable(message) : ""));
</script>

<div class={cssClass}>
    {#if translatedTitle}
        <h3>{translatedTitle}</h3>
    {/if}
    {#if translatedMessage}
        <p>{translatedMessage}</p>
    {/if}
    {@render children?.()}
</div>
