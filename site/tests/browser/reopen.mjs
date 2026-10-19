// Run against `npm run dev -- --host 127.0.0.1 --port 5192` with Playwright installed.
// PLAYWRIGHT_MODULE can point to an existing installation; no live API credentials used.
// SITE-46: exercise real browser interactions, including stale decisions and filter resets.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const output = process.env.SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
const requests = [];
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const body = "These layouts were part of a rollmaxxing test, do not use.";
const common = { layout_id: "layout1", layout_name: "bemboo10", user_id: "100000000000000001", user_name: "deeroh", via: "discord", submitted_at: "2026-10-18T12:00:00Z", decided_by: "100000000000000002", decided_at: "2026-10-18T13:00:00Z", reason: "off topic", review_version: 2 };
const rows = {
  comment: [{ ...common, id: "c1", status: "approved", body, live_body: body }, { ...common, id: "c2", status: "rejected", body: "Rejected comment text", live_body: null }],
  wpm: [{ ...common, id: "w1", status: "approved", wpm: 120, proof: "https://example.org/proof", submitted_by: common.user_id }],
  link: [{ ...common, id: "l1", status: "approved", url: "https://example.org/layout", submitted_by: common.user_id, submitter_name: "deeroh" }],
};
let conflict = false;
await page.route("**/auth/me", (route) => route.fulfill({ json: { user: { user_id: "100000000000000002", name: "Moderator", admin: true, via: "discord" }, signin: true } }));
await page.route("**/api/v1/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  if (url.pathname === "/api/v1/authors") return route.fulfill({ json: { "100000000000000002": "Moderator", "100000000000000003": "Other moderator" } });
  const match = url.pathname.match(/\/admin\/(comment|wpm|link)-queue(?:\/([^/]+)\/(reopen|approve|reject|history))?$/);
  if (!match) return route.fulfill({ json: {} });
  const [, kind, id, action] = match;
  if (!action) return route.fulfill({ json: { submissions: rows[kind].filter((row) => row.status === url.searchParams.get("status")) } });
  if (action === "history") {
    requests.push({ kind, action });
    return route.fulfill({ json: { history: [
      { action: "rejected", actor: "100000000000000002", at: "2026-10-18T12:00:00Z", reason: "off topic", review_version: 1 },
      { action: "reopened", actor: "100000000000000003", at: "2026-10-18T12:30:00Z", reason: null, review_version: 2 },
    ] } });
  }
  assert.equal(req.headers()["x-requested-with"], "akldb");
  requests.push({ kind, id, action, body: req.postDataJSON() });
  if (conflict) return route.fulfill({ status: 409, json: { error: "review_conflict" } });
  const row = rows[kind].find((candidate) => candidate.id === id);
  row.status = action === "reopen" ? "pending" : action === "approve" ? "approved" : "rejected";
  row.review_version++;
  if (action === "reopen") { row.reason = null; row.decided_by = null; row.decided_at = null; }
  return route.fulfill({ json: { submission: row } });
});
try {
  await page.goto(process.env.SITE_URL ?? "http://127.0.0.1:5192/admin");
  const filter = (name) => page.locator(".akl-status-chips").getByRole("button", { name, exact: true });
  await filter("Approved").click();
  await page.getByRole("button", { name: "Reopen review", exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Reopen review", exact: true }).count(), 2, "links do not offer reopen");
  assert.equal(requests.filter((r) => r.action === "history").length, 0, "history is lazy");
  await page.locator(".akl-review-history summary").first().click();
  await page.getByText("Other moderator", { exact: true }).waitFor();
  assert.equal(requests.filter((r) => r.action === "history").length, 1);
  if (output) await page.screenshot({ path: `${output}/approved-desktop.png`, fullPage: true });

  const commentRow = page.locator("tr.akl-has-text");
  await commentRow.getByRole("button", { name: "Reopen review", exact: true }).click();
  await page.getByText("Return to review? This comment will be hidden until approved again.", { exact: true }).waitFor();
  assert.equal(requests.filter((r) => r.action === "reopen").length, 0, "approval requires confirmation");
  if (output) await page.screenshot({ path: `${output}/confirm-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Chrome can stitch a stale viewport into fullPage captures immediately
  // after resizing. Let responsive layout settle, then capture the actual
  // viewport scrolled to the confirmation instead of stitching the page.
  await page.waitForTimeout(300);
  assert.equal(await page.locator("header").count(), 1, "only one header in mobile DOM");
  assert.equal(await page.getByRole("heading", { name: "Moderation", exact: true }).count(), 1, "only one page heading in mobile DOM");
  await commentRow.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator(".akl-reopen-confirm").waitFor({ state: "visible" });
  assert.equal(await page.locator(".akl-comment-text").count(), 1, "approved comment renders once");
  if (output) await page.screenshot({ path: `${output}/confirm-mobile.png`, fullPage: false });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow on mobile");
  assert.equal(await page.locator(".akl-comment-text").evaluate((el) => getComputedStyle(el).fontSize), "15px", "comment remains normal body size");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator(".akl-reopen-confirm").count(), 0);

  await commentRow.getByRole("button", { name: "Reopen review", exact: true }).click();
  await filter("Rejected").click();
  await page.getByText("Rejected comment text", { exact: true }).waitFor();
  assert.equal(await page.locator(".akl-reopen-confirm").count(), 0, "changing filters clears confirmation");
  conflict = true;
  await page.getByRole("button", { name: "Reopen review", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /Refresh the inbox/);
  assert.deepEqual(requests.at(-1), { kind: "comment", id: "c2", action: "reopen", body: { status: "rejected", review_version: 2 } });
  conflict = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Reopen review", exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.getByRole("button", { name: "Reopen review", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(await filter("Pending").getAttribute("aria-current"), "true");
  assert.equal(await page.getByRole("button", { name: "Reopen review", exact: true }).count(), 0);
  if (output) await page.screenshot({ path: `${output}/pending-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await page.getByText("Nothing here", { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { kind: "comment", id: "c2", action: "approve", body: { review_version: 3 } });

  await filter("Approved").click();
  const speedRow = page.locator("tr").filter({ has: page.getByText("120 wpm", { exact: true }) });
  await speedRow.getByRole("button", { name: "Reopen review", exact: true }).click();
  await page.getByText("Return to review? This record will be hidden until approved again. The next-best approved result may appear.", { exact: true }).waitFor();
  await speedRow.locator(".akl-reopen-confirm").getByRole("button", { name: "Reopen review", exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { kind: "wpm", id: "w1", action: "reopen", body: { status: "approved", review_version: 2 } });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByPlaceholder("Reason (optional)").fill("proof unclear");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByText("Nothing here", { exact: true }).waitFor();
  assert.deepEqual(requests.at(-1), { kind: "wpm", id: "w1", action: "reject", body: { reason: "proof unclear", review_version: 3 } });
  assert.deepEqual(errors, []);
  console.log("Reopen browser checks passed (desktop, mobile, history, confirmation, conflicts, pending restore, versioned decisions).");
} finally {
  await browser.close();
}
