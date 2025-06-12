import { mount } from "svelte";
import "./app.css";
import App from "./UITest.svelte";

import {} from "../../../src/PlatformAPIs/SynchromeshLoader.browser";
const app = mount(App, {
    target: document.getElementById("app")!,
});

export default app;
