// The Cloudflare entry: today's Worker, unchanged in behaviour. The app
// itself (routes, sessions, the proxy) lives in index.ts and is shared with
// the Lambda entry (lambda.ts), so the two cannot drift (LDB-SITE9).
import app from "./index.ts";

export default app;
