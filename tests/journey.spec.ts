import { test, expect, type Page } from "@playwright/test";

const places: Record<string, any> = {
  "live-a": { id: "live-a", name: "RK Beach", lat: 17.7145, lng: 83.3237 },
  "live-b": {
    id: "live-b",
    name: "Railway Station",
    lat: 17.7215,
    lng: 83.2905,
  },
};
const stop = { id: "point-stop", name: "RK Beach bus stop", lat: 17.7114, lng: 83.3183 };
const stop2 = { id: "point-stop2", name: "Convent", lat: 17.718, lng: 83.2891 };

function leg(mode: string, origin: any, destination: any, extra: any = {}) {
  return {
    mode,
    origin,
    destination,
    distance: 1000,
    duration: 600,
    cost: 0,
    source: "Google Routes",
    confidence: "Provider supplied",
    polyline: [origin, destination],
    steps: [
      { instruction: `Head to ${destination.name}`, distance: 1000, end: destination },
    ],
    ...extra,
  };
}
function route(id: string, name: string, legs: any[], cost: number, duration: number) {
  return {
    id,
    name,
    legs,
    cost,
    duration,
    distance: legs.reduce((s, l) => s + l.distance, 0),
    walking: legs.filter((l) => l.mode === "WALK").reduce((s, l) => s + l.distance, 0),
    transfers: 0,
    score: 0,
    cost_label: "Estimated fare",
  };
}
const a = places["live-a"];
const b = places["live-b"];
const busRoute = route(
  "bus-route",
  "Public transport",
  [
    leg("WALK", a, stop, { distance: 400 }),
    leg("BUS", stop, stop2, {
      distance: 5600,
      cost: 12,
      line: "28",
      headsign: "Old Gajuwaka",
      fare_kind: "bus",
      base_fare: 11,
      fare_basis: "Rider-checked · 3 riders",
    }),
    leg("WALK", stop2, b, { distance: 700 }),
  ],
  12,
  27,
);
const autoRoute = route(
  "auto-route",
  "Private auto",
  [
    leg("AUTO", a, b, {
      distance: 3900,
      cost: 64,
      source: "Google road distance and time",
      fare_kind: "auto",
      base_fare: 64,
      fare_basis: "Estimate · Ola Auto fare card, Visakhapatnam",
    }),
  ],
  64,
  13,
);
const walkRoute = route("walk-route", "Walk", [leg("WALK", a, b, { distance: 2900 })], 0, 45);

async function mockLive(page: Page, routes: any[] = [busRoute, autoRoute, walkRoute]) {
  await page.route("**/api/places/search*", (r) =>
    r.fulfill({ json: Object.values(places).map((p) => ({ id: p.id, name: p.name })) }),
  );
  await page.route(/\/api\/places\/live-[ab]$/, (r) =>
    r.fulfill({ json: places[r.request().url().split("/").pop()!] }),
  );
  await page.route("**/api/places/stop-photo*", (r) =>
    r.fulfill({ json: { photo: null, name: "stop", attribution: [] } }),
  );
  await page.route("**/api/routes/search", (r) =>
    r.fulfill({
      json: { routes, warnings: [], generated_at: 0, source: "Google Routes" },
    }),
  );
  await page.route("**/api/navigation/start", (r) =>
    r.fulfill({ json: { session_id: "s1", state: "NAVIGATION_STARTED" } }),
  );
  await page.route("**/api/navigation/check", (r) =>
    r.fulfill({
      json: {
        distance_to_target: 300,
        remaining_distance: 300,
        state: "ON_ROUTE",
        deviations: 0,
        recalculate: false,
      },
    }),
  );
}
async function choosePlaces(page: Page) {
  await page
    .getByRole("textbox", { name: "STARTING POINT", exact: true })
    .fill("RK");
  await page.locator(".suggestions button", { hasText: "RK Beach" }).click();
  await page
    .getByRole("textbox", { name: "DESTINATION", exact: true })
    .fill("Rail");
  await page.locator(".suggestions button", { hasText: "Railway Station" }).click();
}
async function fakeGps(page: Page, accuracy = 8) {
  await page.addInitScript((accuracy) => {
    navigator.geolocation.watchPosition = (success) => {
      setTimeout(
        () =>
          success({
            coords: {
              latitude: 17.7287,
              longitude: 83.3085,
              accuracy,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: 1.4,
            },
            timestamp: Date.now(),
          } as GeolocationPosition),
        100,
      );
      return 1;
    };
    navigator.geolocation.clearWatch = () => {};
  }, accuracy);
}

test("live journey: compare, sort, hand off to maps and track", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fakeGps(page);
  await mockLive(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Every step, sorted." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Demo" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Debug" })).toHaveCount(0);
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Cheapest", exact: true }).click();
  await expect(page.locator(".route-card").first()).toContainText("₹0");
  await page.locator(".route-card", { hasText: "Public transport" }).click();
  await expect(page.locator(".timeline-leg.focused")).toContainText(
    "Walk to RK Beach bus stop",
  );
  await page.getByRole("button", { name: "Navigate" }).click();
  const google = await page.getByRole("menuitem", { name: "Google Maps" }).getAttribute("href");
  expect(google).toContain("destination=17.7114%2C83.3183");
  expect(google).toContain("travelmode=walking");
  const apple = await page.getByRole("menuitem", { name: "Apple Maps" }).getAttribute("href");
  expect(apple).toContain("maps.apple.com");
  await page.getByRole("menuitem", { name: "Track in RouteWise only" }).click();
  await expect(page.locator(".live-stats")).toContainText("LIVE");
  await expect(page.locator(".live-stats")).toContainText("5.0 km/h");
  await page.getByRole("button", { name: "Stop tracking" }).click();
  await expect(page.locator(".live-stats")).toHaveCount(0);
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("vehicle settings persist and an empty result is explained", async ({ page }) => {
  await mockLive(page, []);
  await page.goto("/");
  await page.getByRole("button", { name: "My vehicle", exact: true }).click();
  await page.getByLabel("Vehicle name").fill("City bike");
  await page.getByLabel("Mileage").fill("50");
  await page.getByRole("button", { name: "Save vehicle" }).click();
  await page.reload();
  await page.getByRole("button", { name: "My vehicle", exact: true }).click();
  await expect(page.getByLabel("Vehicle name")).toHaveValue("City bike");
  await expect(page.getByLabel("Mileage")).toHaveValue("50");
  await page.getByRole("button", { name: "Close settings" }).click();
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByText("No routes match your preferences.")).toBeVisible();
});

test("GPS denial is visible", async ({ page, context }) => {
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
});

test("mobile layout and API failure display", async ({ page }) => {
  await mockLive(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".route-card").first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await page.unroute("**/api/routes/search");
  await page.route("**/api/routes/search", (r) =>
    r.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Provider unavailable", request_id: "test-123" }),
    }),
  );
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("alert")).toContainText("Provider unavailable (ID: test-123)");
});

test("place search and swap update selected places", async ({ page }) => {
  await mockLive(page);
  await page.goto("/");
  await choosePlaces(page);
  await expect(
    page.getByRole("textbox", { name: "DESTINATION", exact: true }),
  ).toHaveValue("Railway Station");
  await page.getByRole("button", { name: "Swap origin and destination" }).click();
  await expect(
    page.getByRole("textbox", { name: "STARTING POINT", exact: true }),
  ).toHaveValue("Railway Station");
});

test("completes every leg of a multimodal journey", async ({ page }) => {
  await mockLive(page, [busRoute]);
  await page.goto("/");
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".timeline-leg")).toHaveCount(3);
  await page.getByRole("button", { name: "Complete leg", exact: true }).click();
  await expect(page.locator(".timeline-leg.focused")).toContainText("Take bus 28");
  await page.getByRole("button", { name: "Complete leg", exact: true }).click();
  await expect(page.locator(".timeline-leg.focused")).toContainText(
    "Walk to Railway Station",
  );
  await page.getByRole("button", { name: "Mark arrived", exact: true }).click();
  await expect(page.getByText("You’ve completed your journey.")).toBeVisible();
});

test("map controls and legend", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".map-chip")).toContainText("LIVE MAP");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.getByRole("button", { name: "Recenter map", exact: true }).click();
  await page.getByRole("button", { name: "Toggle map legend", exact: true }).click();
  await expect(page.locator(".map-legend")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle map legend", exact: true }).click();
  await expect(page.locator(".map-legend")).toBeVisible();
});

test("GPS success and low accuracy are visible without saving coordinates", async ({
  page,
}) => {
  await fakeGps(page, 100);
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
  await page.getByRole("textbox", { name: "DESTINATION", exact: true }).press("Escape");
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Select a starting point and destination",
  );
});

test("riders can rate a live fare and see what the model learned", async ({
  page,
}) => {
  await mockLive(page, [autoRoute]);
  let vote: any;
  await page.route("**/api/fares/vote", async (r) => {
    vote = r.request().postDataJSON();
    await r.fulfill({
      json: {
        fare: 76,
        voters: 3,
        reports: 3,
        disputed: 0,
        applied: true,
        multiplier: 1.19,
        kind: "auto",
        band: "3-7 km",
      },
    });
  });
  await page.goto("/");
  await choosePlaces(page);
  await page.getByRole("button", { name: "Find my routes" }).click();
  await expect(page.locator(".timeline-leg").first()).toContainText(
    "Private auto to Railway Station",
  );
  await expect(page.locator(".fare-basis").first()).toContainText("Ola Auto fare card");
  await page.getByRole("button", { name: "Wrong" }).click();
  await page.getByLabel("Fare you paid in rupees").fill("100");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".fare-vote.done")).toContainText(
    "This fare is now ₹76, learned from 3 riders.",
  );
  expect(vote).toMatchObject({ route_id: "auto-route", leg: 0, verdict: "wrong", paid: 100 });
  expect(vote.voter.length).toBeGreaterThanOrEqual(32);
});

test("Google authentication failure shows a recoverable error", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    (window as any).gm_authFailure();
  });
  await expect(page.getByRole("alert")).toContainText("Google Maps authentication failed");
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
