import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const messages = [];
page.on("console", (message) => {
  const text = message.text();
  const match = text.match(
    /Google Maps JavaScript API (?:error|warning): ([A-Za-z0-9_]+)/,
  );
  if (match) messages.push(match[1]);
});
await page.goto("http://127.0.0.1:5178");
await page.getByRole("button", { name: "Live", exact: true }).click();
await page.waitForTimeout(10000);
const map = await page.evaluate(() => ({
  google_loaded: !!window.google?.maps,
  map_element: !!document.querySelector(".gm-style"),
  provider_error:
    document.body.textContent.includes(
      "This page can't load Google Maps correctly",
    ) || document.body.textContent.includes("Oops! Something went wrong."),
}));
await page
  .getByRole("textbox", { name: "STARTING POINT", exact: true })
  .fill("Dwaraka Nagar");
await page.waitForTimeout(2500);
const error = await page.locator(".suggestions").innerText();
const report = {
  browser_map: { ...map, errors: messages },
  live_autocomplete: {
    message: error.replace(/AIza[\w-]+/g, "[REDACTED]").slice(0, 800),
  },
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(
  "reports/browser-live-check.json",
  JSON.stringify(report, null, 2),
);
await browser.close();
