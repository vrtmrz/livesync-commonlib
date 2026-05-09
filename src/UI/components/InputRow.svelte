<script lang="ts">
    import { translateIfAvailable } from "@lib/common/i18n";

    type Props = {
        label: string;
        children?: () => any;
    };
    const { label, children }: Props = $props();
    const displayLabel = $derived.by(() => translateIfAvailable(label));
</script>

<label class="row"
    ><span>{displayLabel}</span>
    {@render children?.()}
</label>
