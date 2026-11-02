// [SITE-47] akldb.org serves a real robots.txt: SEO/marketing crawlers are
// refused by name, everyone else (the search engines) may crawl, and the file
// ships as a static asset (Vite's public/ -> dist/), so the Worker's
// [assets] binding answers it as text before the SPA fallback could.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SITE = path.resolve(import.meta.dirname, "..", "..");
const text = fs.readFileSync(path.join(SITE, "public", "robots.txt"), "utf8");

// RFC 9309: a group is one or more User-agent lines followed by its rules;
// a crawler obeys the group naming it, else the `*` group.
function groups(src: string): { agents: string[]; rules: string[] }[] {
  const out: { agents: string[]; rules: string[] }[] = [];
  let cur: { agents: string[]; rules: string[] } | null = null;
  for (const raw of src.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (key!.toLowerCase() === "user-agent") {
      if (cur === null || cur.rules.length > 0) out.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
    } else {
      if (cur === null) throw new Error(`rule before any User-agent: ${line}`);
      cur.rules.push(`${key!.toLowerCase()}:${value}`);
    }
  }
  return out;
}

function rulesFor(agent: string): string[] {
  const g = groups(text);
  return (g.find((x) => x.agents.includes(agent.toLowerCase())) ?? g.find((x) => x.agents.includes("*")))!.rules;
}

describe("[SITE-47] robots.txt", () => {
  it("[SITE-47] refuses the SEO and marketing crawlers by name", () => {
    for (const bot of ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot", "PetalBot", "Bytespider", "DataForSeoBot", "BLEXBot"]) {
      expect(rulesFor(bot), bot).toEqual(["disallow:/"]);
    }
  });

  it("[SITE-47] lets the search engines and everyone else crawl everything", () => {
    for (const bot of ["Googlebot", "Bingbot", "DuckDuckBot", "Applebot", "SomeNewBot"]) {
      expect(rulesFor(bot), bot).toEqual(["allow:/"]);
    }
  });

  it("[SITE-47] ships as a static asset: Vite copies public/ into the dist/ the Worker's [assets] serves, and /robots.txt is not routed to the Worker first", () => {
    const vite = fs.readFileSync(path.join(SITE, "vite.config.ts"), "utf8");
    expect(vite).not.toMatch(/publicDir\s*:/); // the default `public/` stays in force
    const wrangler = fs.readFileSync(path.join(SITE, "wrangler.toml"), "utf8");
    expect(wrangler).toMatch(/directory = "\.\/dist"/);
    const first = wrangler.match(/run_worker_first = \[([^\]]*)\]/)![1]!;
    expect(first).not.toMatch(/robots|"\/\*"/);
  });

  it("[SITE-47] is committed, not generated: public/ is ignored only for the generated adoption.md", () => {
    const ignore = fs.readFileSync(path.join(SITE, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignore).not.toContain("public/");
    expect(ignore).toContain("public/adoption.md");
  });
});
