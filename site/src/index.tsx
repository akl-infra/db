import { render } from "@solidjs/web";
import App from "./App.tsx";

const root = document.getElementById("app");
if (root) render(() => <App />, root);
