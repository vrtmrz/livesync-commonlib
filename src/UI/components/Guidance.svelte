<script lang="ts">
    import { $t as t } from "@lib/common/i18n";

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
    const translatedMessage = $derived.by(() => (message ? t(message) : ""));
</script>

<div class={cssClass}>
    {#if title}
        <h3>{title}</h3>
    {/if}
    {#if translatedMessage}
        <p>{translatedMessage}</p>
    {/if}
    {@render children?.()}
</div>
