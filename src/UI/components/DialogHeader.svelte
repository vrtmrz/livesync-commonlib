<script lang="ts">
    import { onMount, tick } from "svelte";
    import { getDialogContext } from "../svelteDialog.ts";

    type Props = {
        title: string;
        subtitle?: string;
        children?: () => unknown;
    };
    let { title = $bindable(), subtitle, children }: Props = $props();

    $effect(() => {
        if (title) {
            context.setTitle(`${title}${subtitle ? ` - ${subtitle}` : ""}`);
        }
    });
    const context = getDialogContext();
    onMount(async () => {
        context.setTitle(`${title}${subtitle ? ` - ${subtitle}` : ""}`);
        await tick();
        document.querySelector(".modal")?.scrollTo(0, 0);
    });
</script>
