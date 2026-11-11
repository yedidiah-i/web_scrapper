#!/usr/bin/env node
/**
 * pw_fetch.mjs — lightweight Playwright helper for the core worker's browser fallback.
 *
 * Usage: node pw_fetch.mjs <url>
 *
 * Writes the final rendered HTML to stdout and exits 0 on success.
 * Writes an error message to stderr and exits 1 on failure.
 *
 * Requires: npm install -g playwright && npx playwright install chromium
 *
 * The core worker invokes this script only when CORE_BROWSER_FALLBACK=true
 * and the static HTTP fetch returned fewer bytes than CORE_MIN_BODY_BYTES.
 */

import { chromium } from "playwright";

const url = process.argv[2];

if (!url) {
  process.stderr.write("Usage: pw_fetch.mjs <url>\n");
  process.exit(1);
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--window-size=1920,1080",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // Mask WebDriver detection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const page = await context.newPage();

    // Navigate and wait for network to settle
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    // Scroll to trigger lazy-loaded content
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 150);
        // Give up after 5 seconds regardless
        setTimeout(() => { clearInterval(timer); resolve(); }, 5000);
      });
    });

    // Wait a bit for any JS triggered by scrolling
    await page.waitForTimeout(1000);

    const html = await page.content();
    process.stdout.write(html);

    await browser.close();
    process.exit(0);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    process.stderr.write(`pw_fetch error: ${err.message}\n`);
    process.exit(1);
  }
})();
