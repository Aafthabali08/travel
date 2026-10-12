import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN_EMAIL, createUser, logIn, PNG, resetEmulators, signUp } from "./support";

const a = { id: "live-a", name: "RK Beach", lat: 17.7145, lng: 83.3237 };
const b = { id: "live-b", name: "Railway Station", lat: 17.7215, lng: 83.2905 };
const walk = {
  id: "walk-route",
  name: "Walk",
  legs: [
    {
      mode: "WALK",
      origin: a,
      destination: b,
      distance: 2900,
      duration: 2700,
      cost: 0,
      source: "Google Routes",
      confidence: "Provider supplied",
      polyline: [a, b],
      steps: [{ instruction: "Head to Railway Station", distance: 2900, end: b }],
    },
  ],
  cost: 0,
  duration: 45,
  distance: 2900,
  walking: 2900,
  transfers: 0,
  score: 0,
  cost_label: "Free",
};

async function mockApi(page: Page) {
  await page.route("**/api/places/search*", (r) => r.fulfill({ json: [a, b].map((p) => ({ id: p.id, name: p.name })) }));
  await page.route(/\/api\/places\/live-[ab]$/, (r) =>
    r.fulfill({ json: r.request().url().endsWith("live-a") ? a : b }),
  );
  await page.route("**/api/places/stop-photo*", (r) => r.fulfill({ json: { photo: null, name: "stop", attribution: [] } }));
  await page.route("**/api/routes/search", (r) =>
    r.fulfill({ json: { routes: [walk], warnings: [], generated_at: 0, source: "Google Routes" } }),
  );
}
async function choosePlaces(page: Page) {
  await page.getByRole("textbox", { name: "STARTING POINT", exact: true }).fill("RK");
  await page.locator(".suggestions button", { hasText: "RK Beach" }).click();
  await page.getByRole("textbox", { name: "DESTINATION", exact: true }).fill("Rail");
  await page.locator(".suggestions button", { hasText: "Railway Station" }).click();
}
async function quotaText(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  const text = await page.locator(".quota-line").innerText();
  await page.keyboard.press("Escape");
  return text;
}
async function adminPage(browser: Browser, baseURL: string) {
  await createUser(ADMIN_EMAIL, "Aafthab", true);
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await logIn(page, ADMIN_EMAIL);
  return page;
}

test.beforeEach(async () => {
  await resetEmulators();
});

test("demo visitors see the page but must sign in to use it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByText("You’re viewing a demo")).toBeVisible();
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("dialog")).toContainText("Log in");
  await page.getByRole("button", { name: "Close sign-in" }).click();
  await page.getByRole("textbox", { name: "STARTING POINT", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Use my current location" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/#/support");
  await expect(page.getByText("Log in to get help")).toBeVisible();
  await page.goto("/#/admin");
  await expect(page.getByText("Admin sign-in required")).toBeVisible();
  expect(errors).toEqual([]);
});

test("wrong passwords and duplicate sign-ups get clear messages", async ({ page }) => {
  await createUser("taken@example.com", "Taken");
  await page.goto("/");
  await page.locator(".login-btn").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("you@example.com").fill("taken@example.com");
  await dialog.getByPlaceholder("Your password").fill("wrong-password");
  await dialog.locator(".auth-submit").click();
  await expect(dialog.getByRole("alert")).toContainText("don't match");
  await dialog.getByRole("tab", { name: "Sign up" }).click();
  await dialog.getByPlaceholder("you@example.com").fill("taken@example.com");
  await dialog.getByPlaceholder("At least 6 characters").fill("another-pass-1");
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already uses that email");
});

test("sign up, search, and the daily allowance counts down", async ({ page }) => {
  await signUp(page, "Priya Rao", "priya@example.com");
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveText("PR");
  await expect(page.getByText("You’re viewing a demo")).toHaveCount(0);
  expect(await quotaText(page)).toContain("30 of 30 route searches left today");
  await mockApi(page);
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card")).toHaveCount(1);
  await expect.poll(() => quotaText(page)).toContain("29 of 30");
  // Logging out returns to the demo.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.locator(".login-btn")).toBeVisible();
});

test("support ticket round trip: raise, confirm, chat, resolve", async ({ page, browser, baseURL }) => {
  await createUser("sam@example.com", "Sam Lee", true);
  await logIn(page, "sam@example.com", "/#/support");
  await expect(page.getByRole("heading", { name: "How can we help?" })).toBeVisible();
  await page.getByLabel("SUBJECT").fill("Auto fare is too low");
  await page.getByLabel("CATEGORY").selectOption("Route or fare is wrong");
  await page.getByLabel("PRIORITY").selectOption("high");
  await page.getByLabel("DESCRIBE THE PROBLEM").fill("Shown ₹40, driver asked ₹80 from RK Beach.");
  await page.locator('.image-drop input[type="file"]').setInputFiles({ name: "fare.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator(".image-preview")).toContainText("fare.png");
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.getByText(/Ticket #\w{6} submitted/)).toBeVisible();
  const mine = page.locator(".ticket-list li").first();
  await expect(mine).toContainText("Auto fare is too low");
  await expect(mine.locator(".status")).toHaveText("Open");
  await expect(page.locator(".ticket-image img")).toBeVisible();

  const admin = await adminPage(browser, baseURL!);
  await admin.goto("/#/admin/tickets");
  await expect(admin.getByRole("heading", { name: "Tickets" })).toBeVisible();
  await admin.locator(".data-table tr", { hasText: "Auto fare is too low" }).click();
  const panel = admin.locator(".detail-panel");
  await expect(panel).toContainText("Sam Lee");
  await expect(panel.locator(".ticket-image img")).toBeVisible();
  await panel.getByRole("button", { name: "Confirm received" }).click();
  await expect(panel.locator(".ticket-meta .status")).toHaveText("Received");
  await panel.getByLabel("Message", { exact: true }).fill("Thanks Sam, we're checking the fare data.");
  await panel.getByRole("button", { name: "Send message" }).click();

  // The user sees status, reply and a notification in real time.
  await expect(mine.locator(".status")).toHaveText("Received");
  await expect(page.locator(".bubble", { hasText: "checking the fare data" })).toBeVisible();
  await expect(page.locator(".bell-count:visible")).toBeVisible();
  await page.getByRole("button", { name: /Notifications/ }).click();
  await expect(page.locator(".bell-menu:visible")).toContainText("is now Received");
  await page.keyboard.press("Escape");
  await page.getByLabel("Message", { exact: true }).fill("Great, thank you!");
  await page.getByRole("button", { name: "Send message" }).click();

  await admin.goto("/#/admin/chat");
  await admin.locator(".convo-list a", { hasText: "Sam Lee" }).click();
  await expect(admin.locator(".bubble", { hasText: "Great, thank you!" })).toBeVisible();
  await admin.goto("/#/admin/tickets");
  await admin.getByRole("button", { name: /^All/ }).click();
  await admin.locator(".data-table tr", { hasText: "Auto fare is too low" }).click();
  await admin.locator(".detail-panel select").selectOption("resolved");
  await expect(mine.locator(".status")).toHaveText("Resolved");
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(mine.locator(".status")).toHaveText("Open");
  await page.getByRole("button", { name: "Close ticket" }).click();
  await expect(mine.locator(".status")).toHaveText("Closed");
  await expect(page.getByText("This ticket is closed")).toBeVisible();
});

test("admin limits, blocks, notifies and announces", async ({ page, browser, baseURL }) => {
  const uid = await createUser("lim@example.com", "Lim Ito", true);
  await logIn(page, "lim@example.com");
  const admin = await adminPage(browser, baseURL!);

  await admin.goto(`/#/admin/users/${uid}`);
  const panel = admin.locator(".detail-panel");
  await panel.getByLabel("Daily search limit").fill("1");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel).toContainText("Limit saved");

  await mockApi(page);
  await expect.poll(() => quotaText(page)).toContain("1 of 1");
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card")).toHaveCount(1);
  await expect.poll(() => quotaText(page)).toContain("0 of 1");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("alert")).toContainText("used all 1 route searches");

  await panel.getByRole("button", { name: "Block user" }).click();
  await expect(panel).toContainText("User blocked");
  await page.getByRole("button", { name: "Use my current location" }).click();
  await expect(page.getByRole("alert")).toContainText("paused");
  await panel.getByRole("button", { name: "Unblock user" }).click();

  await admin.goto("/#/admin/notifications");
  await admin.getByLabel("TITLE").fill("New bus routes added");
  await admin.getByLabel("MESSAGE").fill("Route 28 now runs every 10 minutes.");
  await admin.getByRole("button", { name: "Send notification" }).click();
  await expect(admin.getByText(/Sent to \d+ users/)).toBeVisible();
  await page.getByRole("button", { name: /Notifications/ }).click();
  await expect(page.locator(".bell-menu:visible")).toContainText("New bus routes added");
  await page.keyboard.press("Escape");

  await admin.goto("/#/admin/settings");
  await admin.getByLabel("ANNOUNCEMENT BANNER (BLANK TO HIDE)").fill("Maintenance tonight 11pm");
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Maintenance tonight 11pm")).toBeVisible();
});

test("errors users see show up under Problems; dashboards load", async ({ page, browser, baseURL }) => {
  await createUser("err@example.com", "Err Case", true);
  await logIn(page, "err@example.com");
  await mockApi(page);
  await page.unroute("**/api/routes/search");
  await page.route("**/api/routes/search", (r) =>
    r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Provider unavailable", request_id: "e2e-1" }) }),
  );
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("alert")).toContainText("Provider unavailable");

  const admin = await adminPage(browser, baseURL!);
  const errors: string[] = [];
  admin.on("pageerror", (e) => errors.push(e.message));
  await admin.goto("/#/admin/problems");
  await expect(admin.locator(".problem-list")).toContainText("Provider unavailable (ID: e2e-1)");
  await expect(admin.locator(".problem-list")).toContainText("1 user");
  for (const [tab, heading] of [
    ["overview", "Overview"],
    ["users", "Users"],
    ["usage", "Usage & quotas"],
    ["chat", "Chat"],
  ]) {
    await admin.goto(`/#/admin/${tab}`);
    await expect(admin.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(admin.locator(".error-banner")).toHaveCount(0);
  }
  await admin.goto("/#/admin/overview");
  await expect(admin.locator(".tile", { hasText: "Total users" })).toContainText("2");
  await expect(admin.locator(".tile", { hasText: "Problems (24h)" })).toContainText("1");
  await admin.goto("/#/admin/problems");
  await admin.getByRole("button", { name: "Resolve" }).click();
  await expect(admin.getByText("No problems reported")).toBeVisible();
  expect(errors).toEqual([]);
});

test("only the verified admin email opens the dashboard", async ({ page, browser, baseURL }) => {
  await createUser("rider@example.com", "Rider", true);
  await logIn(page, "rider@example.com", "/#/admin");
  await expect(page.getByText("This area is for the RouteWise team")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Admin dashboard" })).toHaveCount(0);

  await createUser(ADMIN_EMAIL, "Imposter", false);
  const ctx = await browser.newContext({ baseURL });
  const imposter = await ctx.newPage();
  await logIn(imposter, ADMIN_EMAIL, "/#/admin");
  await expect(imposter.getByText("Verify your email to open the dashboard")).toBeVisible();
  await expect(imposter.locator(".admin-nav")).toHaveCount(0);
});

test("ticket text is shown as text, never run as HTML", async ({ page, browser, baseURL }) => {
  await createUser("x@example.com", "<img src=x onerror=alert(1)>", true);
  await logIn(page, "x@example.com", "/#/support");
  const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`;
  await page.getByLabel("SUBJECT").fill(payload.slice(0, 120));
  await page.getByLabel("DESCRIBE THE PROBLEM").fill(payload);
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.locator(".ticket-list li").first()).toContainText("<img src=x");

  const admin = await adminPage(browser, baseURL!);
  let dialogs = 0;
  admin.on("dialog", (d) => {
    dialogs++;
    d.dismiss();
  });
  await admin.goto("/#/admin/tickets");
  await admin.locator(".data-table tbody tr").first().click();
  await expect(admin.locator(".detail-panel")).toContainText("<script>");
  await admin.goto("/#/admin/chat");
  await admin.goto("/#/admin/users");
  expect(await admin.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
  expect(dialogs).toBe(0);
});

test("dark theme toggles and is remembered", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  expect(bg).toBe("rgb(8, 11, 10)");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
