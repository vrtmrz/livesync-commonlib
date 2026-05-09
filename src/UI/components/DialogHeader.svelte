<script lang="ts">
    import { onMount, tick } from "svelte";
    import { translateIfAvailable } from "@lib/common/i18n";
    import { getDialogContext } from "../svelteDialog.ts";

    type Props = {
        title: string;
        subtitle?: string;
        children?: () => unknown;
    };
    let { title = $bindable(), subtitle, children }: Props = $props();
    const displayTitle = $derived.by(() => translateIfAvailable(title));
    const displaySubtitle = $derived.by(() => (subtitle ? translateIfAvailable(subtitle) : ""));

    $effect(() => {
        if (displayTitle) {
            context.setTitle(`${displayTitle}${displaySubtitle ? ` - ${displaySubtitle}` : ""}`);
        }
    });
    const context = getDialogContext();
    onMount(async () => {
        context.setTitle(`${displayTitle}${displaySubtitle ? ` - ${displaySubtitle}` : ""}`);
        await tick();
        document.querySelector(".modal")?.scrollTo(0, 0);
    });
</script>

<div class="dialog-header">
    <h2>{displayTitle}</h2>
    {#if displaySubtitle}
        <h4>{displaySubtitle}</h4>
    {/if}
</div>

<style>
    .dialog-header {
        display: none;
    }
</style>
