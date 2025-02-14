<script lang="ts">
    import { cmdSyncShim, storeP2PStatusLine, logs } from "./P2PReplicatorShim";
    import P2PReplicatorPane from "../../../../features/P2PSync/P2PReplicator/P2PReplicatorPane.svelte";
    import { onMount, tick } from "svelte";

    let synchronised = $state(cmdSyncShim.init());

    onMount(() => {
        return () => {
            synchronised.then((e) => e.close());
        };
    });
    let elP: HTMLDivElement;
    logs.subscribe((log) => {
        tick().then(() => elP?.scrollTo({ top: elP.scrollHeight }));
    });
</script>

<main>
    <div class="control">
        {#await synchronised then cmdSync}
            <P2PReplicatorPane plugin={cmdSync.plugin} {cmdSync}></P2PReplicatorPane>
        {:catch error}
            <p>{error.message}</p>
        {/await}
    </div>
    <div class="log">
        <div class="status">
            {$storeP2PStatusLine}
        </div>
        <div class="logslist" bind:this={elP}>
            {#each $logs as log}
                <p>{log}</p>
            {/each}
        </div>
    </div>
</main>

<style>
    main {
        display: flex;
        flex-direction: row;
        flex-grow: 1;
        max-height: 100vh;
        box-sizing: border-box;
    }
    .log {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: flex-start;
        padding: 1em;
        width: 50%;
        min-width: 50%;
    }
    .control {
        padding: 1em 1em;
        overflow-y: scroll;
        flex-grow: 1;
    }
    .status {
        flex-grow: 0;
        /* max-height: 40px; */
        /* height: 40px; */
        flex-shrink: 0;
    }
    .logslist {
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: flex-start;
        /* padding: 1em; */
        width: 100%;
        overflow-y: scroll;
        flex-grow: 1;
        flex-shrink: 1;
        /* max-height: calc(100% - 40px); */
    }
    p {
        margin: 0;
        white-space: pre-wrap;
        text-align: left;
        word-break: break-all;
    }
    :global(body) {
        --background-primary: #ffffff;
        --background-primary-alt: #e9e9e9;
        --size-4-1: 0.25em;
        --tag-background: #f0f0f0;
        --tag-border-width: 1px;
        --tag-border-color: #cfffdd;
        --background-modifier-success: #d4f3e9;
        --background-secondary: #f0f0f0;
        --background-modifier-error: #f8d7da;
        --background-modifier-error-hover: #f5c6cb;
        --interactive-accent: #007bff;
        --interactive-accent-hover: #0056b3;
        --text-normal: #333;
        --text-warning: #f0ad4e;
    }
</style>
