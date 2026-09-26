import { test, expect } from "@playwright/test";
test("complete demo journey, sorting, simulation, and terminal debug events", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Every step, sorted." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card").first()).toBeVisible();
  await expect(page.locator(".source-notice")).toContainText(
    "Illustrative demo",
  );
  await page.getByRole("button", { name: "Cheapest", exact: true }).click();
  await expect(page.locator(".route-card").first()).toContainText("₹");
  await page.locator(".route-card").first().click();
  await page.getByRole("button", { name: "Simulate this leg" }).click();
  await expect(page.locator(".navigation-live")).toBeVisible();
  await expect(page.locator(".navigation-live")).toContainText("SIMULATION");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Debug", exact: true }).click();
  await expect(page.getByText("Journey debugger")).toBeVisible();
  await page.getByRole("textbox", { name: "Filter logs" }).fill("navigation");
  await expect(page.locator(".log-list")).toContainText(
    "navigation.leg.started",
  );
  await page.getByRole("button", { name: "Close debugger" }).click();
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("vehicle assumptions persist and filter excludes all routes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "My vehicle", exact: true }).click();
  await page.getByLabel("Vehicle name").fill("City bike");
  await page.getByLabel("Mileage").fill("50");
  await page.getByRole("button", { name: "Save vehicle" }).click();
  await page.reload();
  await page.getByRole("button", { name: "My vehicle", exact: true }).click();
  await expect(page.getByLabel("Vehicle name")).toHaveValue("City bike");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Journey preferences" }).click();
  await page.getByLabel("Maximum budget").fill("0");
  await page.getByLabel("Maximum walking").fill("0");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(
    page.getByText("No routes match your preferences."),
  ).toBeVisible();
});
test("GPS denial is visible and logged", async ({ page, context }) => {
  await context.clearPermissions();
  await page.addInitScript(() => {
    navigator.geolocation.watchPosition = (_success, error) => {
      setTimeout(
        () =>
          error?.({
            code: 1,
            message: "Denied",
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          }),
        100,
      );
      return 1;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Use my current location" }).click();
  await expect(page.getByRole("alert")).toContainText("permission was denied");
  await page.getByRole("button", { name: "View logs" }).click();
  await expect(page.locator(".log-list")).toContainText("error.displayed");
});
test("mobile layout and API failure display", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.route("**/api/routes/search", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Provider unavailable",
        request_id: "test-123",
      }),
    }),
  );
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Provider unavailable (ID: test-123)",
  );
});
test("place search and swap update selected places", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "DESTINATION", exact: true })
    .fill("RK");
  await page.getByRole("button", { name: /RK Beach Beach Road/ }).click();
  await expect(
    page.getByRole("textbox", { name: "DESTINATION", exact: true }),
  ).toHaveValue("RK Beach");
  await page
    .getByRole("button", { name: "Swap origin and destination" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "STARTING POINT", exact: true }),
  ).toHaveValue("RK Beach");
});

test("completes every leg of a multimodal journey", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card").first()).toBeVisible();
  await page
    .locator(".route-card")
    .filter({ has: page.locator(".mode-chain b", { hasText: "28" }) })
    .filter({ hasText: "0 transfers" })
    .click();
  await expect(page.locator(".timeline-leg")).toHaveCount(3);
  await page.getByRole("button", { name: "Complete leg", exact: true }).click();
  await expect(page.locator(".timeline-leg.focused")).toContainText(
    "Take bus 28",
  );
  await page.getByRole("button", { name: "Complete leg", exact: true }).click();
  await expect(page.locator(".timeline-leg.focused")).toContainText(
    "Walk to Visakhapatnam Railway Station",
  );
  await page.getByRole("button", { name: "Mark arrived", exact: true }).click();
  await expect(page.getByText("You’ve completed your journey.")).toBeVisible();
});

test("map controls and downloadable debug logs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card").first()).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Recenter map", exact: true }).click();
  await page
    .getByRole("button", { name: "Toggle map legend", exact: true })
    .click();
  await expect(page.locator(".map-legend")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Toggle map legend", exact: true })
    .click();
  await expect(page.locator(".map-legend")).toBeVisible();
  await page.getByRole("button", { name: "Debug", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export debug logs" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("routewise-events.jsonl");
  await page.getByRole("textbox", { name: "Filter logs" }).fill("map.zoom");
  await expect(page.locator(".log-list")).toContainText("map.zoom");
});

test("GPS success and low accuracy are visible without saving coordinates", async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.geolocation.watchPosition = (success) => {
      setTimeout(
        () =>
          success({
            coords: {
              latitude: 17.7287,
              longitude: 83.3085,
              accuracy: 100,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          } as GeolocationPosition),
        100,
      );
      return 1;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Use my current location" }).click();
  await expect(
    page.getByRole("textbox", { name: "STARTING POINT", exact: true }),
  ).toHaveValue("Current location");
  await expect(page.locator(".map-bottom")).toContainText("Low accuracy");
  await expect(page.locator(".map-bottom")).toContainText("±100 m");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "17.7287",
  );
});

test("unselected destination text cannot search the previous place", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "DESTINATION", exact: true })
    .fill("unselected destination");
  await page
    .getByRole("textbox", { name: "DESTINATION", exact: true })
    .press("Escape");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Select a starting point and destination",
  );
});

test("riders can rate a live fare and see what the model learned", async ({
  page,
}) => {
  const places: Record<string, any> = {
    "live-a": { id: "live-a", name: "RK Beach", lat: 17.7145, lng: 83.3237 },
    "live-b": {
      id: "live-b",
      name: "Railway Station",
      lat: 17.7215,
      lng: 83.2905,
    },
  };
  await page.route("**/api/places/search*", (r) =>
    r.fulfill({
      json: Object.values(places).map((p) => ({ id: p.id, name: p.name })),
    }),
  );
  await page.route(/\/api\/places\/live-[ab]$/, (r) =>
    r.fulfill({ json: places[r.request().url().split("/").pop()!] }),
  );
  const leg = {
    mode: "AUTO",
    origin: places["live-a"],
    destination: places["live-b"],
    distance: 5000,
    duration: 900,
    cost: 75,
    source: "Google road distance and time",
    confidence: "Provider supplied",
    polyline: [
      { lat: 17.7145, lng: 83.3237 },
      { lat: 17.7215, lng: 83.2905 },
    ],
    steps: [
      {
        instruction: "Head west",
        distance: 5000,
        end: { lat: 17.7215, lng: 83.2905 },
      },
    ],
    fare_kind: "auto",
    base_fare: 75,
    fare_basis: "Estimate · Ola Auto fare card, Visakhapatnam",
    fare_reports: 0,
  };
  await page.route("**/api/routes/search", (r) =>
    r.fulfill({
      json: {
        routes: [
          {
            id: "r1",
            name: "Private auto",
            legs: [leg],
            demo: false,
            cost: 75,
            duration: 15,
            distance: 5000,
            walking: 0,
            transfers: 0,
            score: 0,
            cost_label: "Estimated fare",
          },
        ],
        warnings: [],
        generated_at: 0,
        source: "Google Routes",
      },
    }),
  );
  let vote: any;
  await page.route("**/api/fares/vote", async (r) => {
    vote = r.request().postDataJSON();
    await r.fulfill({
      json: {
        fare: 97,
        voters: 3,
        reports: 3,
        disputed: 0,
        applied: true,
        multiplier: 1.297,
        kind: "auto",
        band: "3-7 km",
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page
    .getByRole("textbox", { name: "STARTING POINT", exact: true })
    .fill("RK");
  await page.locator(".suggestions button", { hasText: "RK Beach" }).click();
  await page
    .getByRole("textbox", { name: "DESTINATION", exact: true })
    .fill("Rail");
  await page
    .locator(".suggestions button", { hasText: "Railway Station" })
    .click();
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".timeline-leg").first()).toContainText(
    "Private auto to Railway Station",
  );
  await expect(page.locator(".fare-basis").first()).toContainText(
    "Ola Auto fare card",
  );
  await page.getByRole("button", { name: "Wrong" }).click();
  await page.getByLabel("Fare you paid in rupees").fill("100");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".fare-vote.done")).toContainText(
    "This fare is now ₹97, learned from 3 riders.",
  );
  expect(vote).toMatchObject({
    route_id: "r1",
    leg: 0,
    verdict: "wrong",
    paid: 100,
  });
  expect(vote.voter.length).toBeGreaterThanOrEqual(32);
});

test("Google authentication callback displays a recoverable error", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Live", exact: true }).click();
  await page.evaluate(() => {
    (window as any).gm_authFailure();
  });
  await expect(page.getByRole("alert")).toContainText(
    "Google Maps authentication failed",
  );
  await page.getByRole("button", { name: "Demo", exact: true }).click();
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card").first()).toBeVisible();
});
