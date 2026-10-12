import { expect, type Page } from "@playwright/test";

// Firebase emulator endpoints (see firebase.json). "Bearer owner" is the emulator's admin bypass.
const PROJECT = "demo-routewise";
const AUTH = "http://127.0.0.1:9099";
const FIRESTORE = "http://127.0.0.1:8080";
export const ADMIN_EMAIL = "aafthabali08@gmail.com";
export const PASSWORD = "test-pass-123";

export async function resetEmulators() {
  await Promise.all([
    fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" }),
    fetch(`${FIRESTORE}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
      method: "DELETE",
    }),
  ]);
}

export async function createUser(email: string, name: string, verified = false) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const { localId } = await res.json();
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
    body: JSON.stringify({ localId, displayName: name, emailVerified: verified }),
  });
  return localId as string;
}

export async function logIn(page: Page, email: string, path = "/") {
  await page.goto(path);
  // The planner stays mounted (hidden) behind other pages, so pick the visible button.
  await page.locator(".login-btn:visible").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("you@example.com").fill(email);
  await dialog.getByPlaceholder("Your password").fill(PASSWORD);
  await dialog.locator(".auth-submit").click();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
}

export async function signUp(page: Page, name: string, email: string) {
  await page.goto("/");
  await page.locator(".signup-btn:visible").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Your name").fill(name);
  await dialog.getByPlaceholder("you@example.com").fill(email);
  await dialog.getByPlaceholder("At least 6 characters").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
}

// A real PNG so the browser's image decoder and canvas compression path run end to end.
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAIElEQVR4nGP8z4AdMOEQH5UYlRiVGJUYlRiVGJUYlQAAwvsBDyEJ8YsAAAAASUVORK5CYII=",
  "base64",
);
