import { createApp } from "vue";
import App from "./App.vue";
import { installAudioUnlock } from "./alerts";
import { start } from "./store";
import "./styles.css";

installAudioUnlock();
start();
createApp(App).mount("#app");
