import { test, expect, type Page } from "@playwright/test";
import { readActiveUsersByRole } from "../src/csvUsers";

const LOGIN_SETTLE_MS = Number(process.env.LOGIN_SETTLE_MS ?? "1200");

async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  let sessionRevoked = false;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const yesButton = dialog.getByRole("button", { name: "Sí" });
    const acceptButton = dialog.getByRole("button", { name: "Aceptar" });
    const okButton = dialog.getByRole("button", { name: "OK" });

    const visibleButton = await Promise.race([
      yesButton.waitFor({ state: "visible", timeout: 10_000 }).then(() => yesButton).catch(() => null),
      acceptButton.waitFor({ state: "visible", timeout: 10_000 }).then(() => acceptButton).catch(() => null),
      okButton.waitFor({ state: "visible", timeout: 10_000 }).then(() => okButton).catch(() => null)
    ]);

    if (!visibleButton) {
      break;
    }

    const dialogText = await dialog.innerText().catch(() => "");
    if (dialogText.includes("La sesión fue revocada")) {
      sessionRevoked = true;
    }

    await visibleButton.click();
    await page.waitForTimeout(700);
  }

  return sessionRevoked;
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  const sessionRevoked = await dismissBlockingDialogs(page);

  if (sessionRevoked || page.url().includes("/auth/sign-in")) {
    await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await dismissBlockingDialogs(page);
  }

  await page.waitForTimeout(LOGIN_SETTLE_MS);
  await expect(page).toHaveURL(/\/home(?:\/)?$/, { timeout: 30_000 });
}

async function openRoundtableAccess(page: Page): Promise<void> {
  if (page.url().includes("/auth/sign-in")) {
    throw new Error("No hay sesión activa al intentar abrir Acceso a ruedas.");
  }

  await page.locator("a").filter({ hasText: "Transaccional" }).click();
  await page.waitForTimeout(500);
  await page.locator("a").filter({ hasText: "Acceso a ruedas" }).click();
  
  // Wait for the table headers to be visible
  await page.getByRole("columnheader", { name: "Código de rueda" }).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  if (page.url().includes("/auth/sign-in")) {
    throw new Error("La sesión volvió a login al intentar abrir Acceso a ruedas.");
  }
}

test("debug: test selector paths on roundtable table", async ({ page }) => {
  const [buyer] = await readActiveUsersByRole("buyer");
  expect(buyer, "Debe existir al menos un comprador activo").toBeDefined();

  await login(page, buyer.username, buyer.password);
  await openRoundtableAccess(page);

  console.log(`URL after openRoundtableAccess: ${page.url()}`);

  // Wait extra for data to load
  await page.waitForTimeout(3_000);

  // Check text elements
  const text327 = page.locator("text=327");
  console.log(`text=327 count: ${await text327.count()}`);

  const textHabilitado = page.locator("text=Habilitado");
  console.log(`text=Habilitado count: ${await textHabilitado.count()}`);

  // Check with exact regex
  const regex327 = page.locator(`text=/^327$/`);
  console.log(`text=/^327$/ count: ${await regex327.count()}`);

  // Check all td cells
  const tdCells = page.locator("td");
  const tdCount = await tdCells.count();
  console.log(`td cells count: ${tdCount}`);

  // If there are td cells, get text of first few
  for (let i = 0; i < Math.min(tdCount, 10); i++) {
    const text = await tdCells.nth(i).innerText().catch(() => "");
    console.log(`  td[${i}]: "${text}"`);
  }

  // Check all rows
  const allRows = page.locator("tr");
  console.log(`tr count: ${await allRows.count()}`);

  // Try page content search
  const content = await page.content();
  console.log(`Page contains "327": ${content.includes("327")}`);
  console.log(`Page contains "Habilitado": ${content.includes("Habilitado")}`);

  await page.screenshot({ path: "debug-3-final.png" });
});
