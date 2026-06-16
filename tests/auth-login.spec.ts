import { test, expect, type Page } from "@playwright/test";
import { readActiveUsersByRole } from "../src/csvUsers";

const MANUAL_CAPTCHA_WAIT_MS = Number(process.env.MANUAL_CAPTCHA_WAIT_MS ?? "45000");
const REQUIRE_CAPTCHA_SOLVED = process.env.REQUIRE_CAPTCHA_SOLVED === "true";

async function attemptLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);

  // Con captcha activo, este test valida el pre-login y deja una ventana para resolverlo manualmente.
  await expect(page.frameLocator('iframe[title="reCAPTCHA"]').getByText("I'm not a robot")).toBeVisible();

  if (MANUAL_CAPTCHA_WAIT_MS > 0) {
    await page.waitForTimeout(MANUAL_CAPTCHA_WAIT_MS);
  }

  if (REQUIRE_CAPTCHA_SOLVED) {
    await expect(page.getByRole("button", { name: "Ingresar" })).toBeEnabled();
  }
}

test.describe("Login MCE QA", () => {
  test("comprador llega a pantalla de autenticacion con captcha", async ({ page }) => {
    const [buyer] = await readActiveUsersByRole("buyer");
    expect(buyer, "Debe existir al menos un comprador activo en data/users.csv").toBeDefined();
    await attemptLogin(page, buyer.username, buyer.password);
  });

  test("vendedor llega a pantalla de autenticacion con captcha", async ({ page }) => {
    const [seller] = await readActiveUsersByRole("seller");
    expect(seller, "Debe existir al menos un vendedor activo en data/users.csv").toBeDefined();
    await attemptLogin(page, seller.username, seller.password);
  });
});
