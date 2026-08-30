import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { dismissPublicTestBanner, preseedLearningMode } from "../_helpers";
test.use({ viewport: { width: 1440, height: 900 } });
test("capture", async ({ page }) => {
  test.setTimeout(120_000);
  const seen: Array<{ url: string; body: unknown }> = [];
  page.on("response", async (r) => {
    const u = r.url();
    if (!/supabase|\/api\//.test(u)) return;
    if (/\.(js|css|png|svg|woff2?)/.test(u)) return;
    try { seen.push({ url: u, body: await r.json() }); } catch { /* non-json */ }
  });
  await preseedLearningMode(page);
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10000);
  await dismissPublicTestBanner(page);
  writeFileSync("/tmp/capsule_capture.json", JSON.stringify(seen, null, 1));
  for (const s of seen) {
    const b = s.body as Record<string, unknown>;
    console.log("URL", s.url.replace(/^https?:\/\/[^/]+/, ""), "KEYS", Array.isArray(b) ? `array[${b.length}]` : Object.keys(b).slice(0, 18).join(","));
  }
});
