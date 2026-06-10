<script lang="ts">
    import { onMount } from "svelte";
    import type { GuestDialogProps } from "@lib/UI/svelteDialog.ts";
    import DialogHeader from "@lib/UI/components/DialogHeader.svelte";
    import Instruction from "@lib/UI/components/Instruction.svelte";
    import InputRow from "@lib/UI/components/InputRow.svelte";
    import Decision from "@lib/UI/components/Decision.svelte";
    import UserDecisions from "@lib/UI/components/UserDecisions.svelte";
    import InfoNote from "@lib/UI/components/InfoNote.svelte";
    const TYPE_OK = "ok";
    type ResultType = typeof TYPE_OK;
    type Options = {
        title?: string;
        dataToCopy: string;
    };
    type Props = GuestDialogProps<ResultType, Options>;
    const { setResult, getInitialData }: Props = $props();
    let dataToCopy = $state("");
    let title = $state<string | undefined>(undefined);
    let copied = $state(false);
    onMount(() => {
        if (getInitialData) {
            const initialData = getInitialData();
            if (initialData) {
                dataToCopy = initialData.dataToCopy;
                title = initialData.title;
            }
        }
    });
    function commit() {
        setResult(TYPE_OK);
    }
    async function copyToClipboard() {
        await navigator.clipboard.writeText(dataToCopy);
        copied = true;
    }
</script>

<DialogHeader title="Your {title || 'Data'} is ready to be copied" />
<Instruction>
    <InputRow label={title || "Data to Copy"}>
        <textarea readonly rows="4">{dataToCopy}</textarea>
        <button onclick={() => copyToClipboard()}
            >{#if !copied}📋{:else}✔️{/if}
        </button>
    </InputRow>
</Instruction>
<InfoNote visible={copied}>
    Your {title || "data"} has been copied to the clipboard.
</InfoNote>
<UserDecisions>
    <Decision title="OK" important={true} {commit} />
</UserDecisions>

<style>
    textarea {
        resize: none;
    }
</style>
