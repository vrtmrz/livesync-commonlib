<script lang="ts">
    import { fireAndForget } from "octagonal-wheels/promises";
    import { translateIfAvailable } from "@lib/common/i18n";

    type Props = {
        title: string;
        commit: () => Promise<void> | void;
        important?: boolean;
        destructive?: boolean;
        additionalClasses?: string;
        disabled?: boolean;
    };
    let { title, commit, additionalClasses, important, disabled = $bindable(), destructive }: Props = $props();
    const displayTitle = $derived.by(() => translateIfAvailable(title));
    function onclick() {
        fireAndForget(async () => commit());
    }
</script>

<button
    class="button {additionalClasses} {important ? 'mod-cta' : ''} {destructive ? 'mod-destructive' : ''}"
    {onclick}
    {disabled}>{displayTitle}</button
>
