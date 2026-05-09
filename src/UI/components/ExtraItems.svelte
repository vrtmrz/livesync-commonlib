<script lang="ts">
    import { translateIfAvailable } from "@lib/common/i18n";

    type Props = {
        title?: string;
        children?: () => any;
    };
    const { children, title }: Props = $props();
    const displayTitle = $derived.by(() => (title ? translateIfAvailable(title) : ""));
</script>

<details>
    <summary>{displayTitle}</summary>
    <div class="sub-section">
        {@render children?.()}
    </div>
</details>
