<script lang="ts">
    import { setContext } from "svelte";
    import { $t as t } from "@lib/common/i18n";

    type Props = {
        children?: () => any;
        message?: string;
    };
    const { children, message }: Props = $props();
    const translatedMessage = $derived.by(() => (message ? t(message) : ""));
</script>

<div class="question-container">
    {#if translatedMessage}
        <p>{translatedMessage}</p>
    {/if}
    {@render children?.()}
</div>
