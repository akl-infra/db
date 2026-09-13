import { render } from "@solidjs/web";
import App from "./App.tsx";
// Dev-only `?mock=admin`/`?mock=owner` QA switch (W1b deliverable 5): a
// STATIC import (not dynamic -- a dynamic `import()` still gets emitted as
// its own chunk file in `dist/` regardless of whether the call site is
// dead code, since Rollup/Rolldown treats every dynamic-import target as
// its own code-splitting root during graph construction, independent of
// later constant folding). `import.meta.env.DEV` is a compile-time
// constant Vite inlines to the literal `false` in a production build, so
// the guard below becomes `if (false) applyDevMock();` before Rollup's
// tree-shaking pass runs; with the only call site now dead, the imported
// binding is unused and the whole `lib/devMock.ts` module (which has no
// other side effects) is dropped from the bundle entirely ([SITE-16]
// builds and greps `dist/` to prove it).
import { applyDevMock } from "./lib/devMock.ts";

if (import.meta.env.DEV) applyDevMock();

const root = document.getElementById("app");
if (root) render(() => <App />, root);
