<script lang="ts">
    import type { Menu, MenuItem, MenuSeparator } from "@lib/services/implements/browser/Menu";

    type Props = {
        item: MenuSeparator;
    };
    const { item = $bindable() }: Props = $props();
</script>

<hr />
