<script lang="ts">
    import { onMount } from "svelte";
    import { Synchromesh } from "../../../src/PlatformAPIs/Synchromesh";
    import { eventHub } from "../../../src/hub/hub";
    import { EVENT_BROWSER_INFO_SUPPLIED } from "../../../src/PlatformAPIs/browser/base";
    import { getConfirmInstance } from "../../../src/PlatformAPIs/Confirm";
    import { Menu } from "../../../src/PlatformAPIs/browser/Menu";
    let result = $state<string | boolean>("");
    onMount(() => {
        eventHub.emitEvent(EVENT_BROWSER_INFO_SUPPLIED, {
            vaultName: "test",
            manifestVersion: "0.0.1",
            packageVersion: "0.0.1",
        });
    });
    async function testUI() {
        const confirm = await getConfirmInstance();
        const ret = await confirm.askString("Your name", "What is your name?", "John Doe", false);
        result = ret;
    }
    let resultPassword = $state<string | boolean>("");
    async function testPassword() {
        const confirm = await getConfirmInstance();
        const ret = await confirm.askString("passphrase", "?", "anythingonlyyouknow", true);
        resultPassword = ret;
    }

    async function testMenu(event: MouseEvent) {
        const m = new Menu()
            .addItem((item) => item.setTitle("📥 Only Fetch").onClick(() => {}))
            .addItem((item) => item.setTitle("📤 Only Send").onClick(() => {}))
            .addSeparator()
            .addItem((item) => {
                item.setTitle("🔧 Get Configuration").onClick(async () => {
                    console.log("Get Configuration");
                });
            })
            .addSeparator()
            .addItem((item) => {
                const mark = "checkmark";
                item.setTitle("Toggle Sync on connect")
                    .onClick(async () => {
                        console.log("Toggle Sync on connect");
                        // await this.toggleProp(peer, "syncOnConnect");
                    })
                    .setIcon(mark);
            })
            .addItem((item) => {
                const mark = null;
                item.setTitle("Toggle Watch on connect")
                    .onClick(async () => {
                        console.log("Toggle Watch on connect");
                        // await this.toggleProp(peer, "watchOnConnect");
                    })
                    .setIcon(mark);
            })
            .addItem((item) => {
                const mark = null;
                item.setTitle("Toggle Sync on `Replicate now` command")
                    .onClick(async () => {})
                    .setIcon(mark);
            });
        m.showAtPosition({ x: event.x, y: event.y });
    }
</script>

<main>
    <h1>UI Test</h1>
    <article>
        <div>
            <button onclick={() => testUI()}> String input </button>
            → {result}
        </div>
        <div>
            <button onclick={() => testPassword()}> Password Input </button>
            → {resultPassword}
        </div>
        <div>
            <button onclick={testMenu}>Menu</button>
        </div>
    </article>
</main>
