import { test, expect, type Page } from "@playwright/test";
import { readActiveUsersByRole } from "../src/csvUsers";

const CAPTCHA_SOLVE_TIMEOUT_MS = Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS ?? "180000");
const POST_LOGIN_WAIT_MS = Number(process.env.POST_LOGIN_WAIT_MS ?? "20000");

async function openAndPrepareLogin(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
}

test.describe("Automatizacion login MCE", () => {
  test("despues de resolver captcha entra al principal y espera 20 segundos", async ({ page }) => {
    test.setTimeout(CAPTCHA_SOLVE_TIMEOUT_MS + POST_LOGIN_WAIT_MS + 60_000);

    const buyers = await readActiveUsersByRole("buyer");
    const sellers = await readActiveUsersByRole("seller");
    const users = [...buyers, ...sellers];

    expect(users.length, "No hay usuarios activos en data/users.csv").toBeGreaterThan(0);

    const user = users[0];
    await openAndPrepareLogin(page, user.username, user.password);

    const loginButton = page.getByRole("button", { name: "Ingresar" });

    // Espera manual para resolver captcha; cuando se habilita el boton se ejecuta el login.
    await expect(loginButton).toBeEnabled({ timeout: CAPTCHA_SOLVE_TIMEOUT_MS });
    await loginButton.click();

    // Confirma salida de la ruta de login como validacion minima de acceso a pantalla principal.
    await expect(page).not.toHaveURL(/\/auth\/sign-in/, { timeout: 30000 });

    await page.waitForTimeout(POST_LOGIN_WAIT_MS);
  });
});
