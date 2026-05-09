<script lang="ts">
    import { setContext } from "svelte";
    import { translateIfAvailable } from "@lib/common/i18n";

    type Props = {
        children?: () => any;
        message?: string;
    };
    const { children, message }: Props = $props();
    const translatedMessage = $derived.by(() => (message ? translateIfAvailable(message) : ""));
</script>

<div class="question-container">
    {#if translatedMessage}
        <p>{translatedMessage}</p>
    {/if}
    {@render children?.()}
</div>
