import { test, expect, type Page } from "@playwright/test";
import { readActiveUsersByRole } from "../src/csvUsers";

const LOGIN_SETTLE_MS = Number(process.env.LOGIN_SETTLE_MS ?? "1200");
const ROUNDTABLE_CODE = process.env.ROUNDTABLE_CODE ?? "327";
const ROUNDTABLE_RETRY_INTERVAL_MS = Number(process.env.ROUNDTABLE_RETRY_INTERVAL_MS ?? "60000");
const ROUNDTABLE_MAX_RETRIES = Number(process.env.ROUNDTABLE_MAX_RETRIES ?? "5");
const BID_QTY = Number(process.env.BID_QTY ?? "1");
const BID_FNCER = Number(process.env.BID_FNCER ?? "5");

// Ronda 2 prices (random per run)
function buyPrice(): number { return Math.floor(Math.random() * (500 - 10 + 1)) + 10; }
function sellPrice(): number { return Math.floor(Math.random() * (1000 - 800 + 1)) + 800; }

async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  let sessionRevoked = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const yesBtn = dialog.getByRole("button", { name: "Sí" });
    const acceptBtn = dialog.getByRole("button", { name: "Aceptar" });
    const okBtn = dialog.getByRole("button", { name: "OK" });
    const visibleButton = await Promise.race([
      yesBtn.waitFor({ state: "visible", timeout: 10_000 }).then(() => yesBtn).catch(() => null),
      acceptBtn.waitFor({ state: "visible", timeout: 10_000 }).then(() => acceptBtn).catch(() => null),
      okBtn.waitFor({ state: "visible", timeout: 10_000 }).then(() => okBtn).catch(() => null),
    ]);
    if (!visibleButton) break;
    const dialogText = await dialog.innerText().catch(() => "");
    if (dialogText.includes("La sesión fue revocada")) sessionRevoked = true;
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
  // Give Angular time to navigate before checking URL
  await page.waitForTimeout(2_000);
  if (sessionRevoked || page.url().includes("/auth/sign-in")) {
    // Navigate back to sign-in if needed
    if (!page.url().includes("/auth/sign-in")) {
      await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
    }
    await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await dismissBlockingDialogs(page);
  }
  await page.waitForTimeout(LOGIN_SETTLE_MS);
  await expect(page).toHaveURL(/\/home(?:\/)?$/, { timeout: 30_000 });
}

async function closeAcceptDialogIfVisible(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) return;
  const acceptButton = dialog.getByRole("button", { name: "Aceptar" });
  const okButton = dialog.getByRole("button", { name: "OK" });
  if (await acceptButton.isVisible().catch(() => false)) {
    await acceptButton.click();
  } else if (await okButton.isVisible().catch(() => false)) {
    await okButton.click();
  }
  await page.waitForTimeout(300);
}

async function enterRoundtable(page: Page, roundtableCode: string = ROUNDTABLE_CODE): Promise<void> {
  // Helper to navigate to roundtable access page
  async function navigateToRoundtableTable(): Promise<void> {
    if (!page.url().includes("access-business-roundtable")) {
      const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
      await transMenu.waitFor({ state: "visible", timeout: 10_000 });
      await transMenu.click({ force: true });
      await page.waitForTimeout(500);
      await page.locator("a").filter({ hasText: "Acceso a ruedas" }).click();
      await page.getByRole("columnheader", { name: "Código de rueda" }).waitFor({ state: "visible", timeout: 15_000 });
    }
    await page.waitForTimeout(2_000);
  }

  let retryCount = 0;
  while (retryCount < ROUNDTABLE_MAX_RETRIES) {
    console.log(`Intento ${retryCount + 1}/${ROUNDTABLE_MAX_RETRIES} de apertura de rueda ${roundtableCode}`);
    await navigateToRoundtableTable();

    const codeCell = page.locator(".mat-column-code td, td.mat-column-code").filter({ hasText: roundtableCode }).first();
    const elementCount = await page.locator(`text=${roundtableCode}`).count();
    console.log(`Elementos con código ${roundtableCode}: ${elementCount}`);

    if (elementCount === 0) {
      retryCount += 1;
      if (retryCount < ROUNDTABLE_MAX_RETRIES) await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
      continue;
    }

    const roundtableEl = page.locator(`text=${roundtableCode}`).first();
    await roundtableEl.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const row = roundtableEl.locator("xpath=ancestor::tr | ancestor::mat-row | ancestor::*[@role='row']").first();
    const habilitadoInRow = row.locator("text=Habilitado").first();
    if (await habilitadoInRow.count() > 0 && await habilitadoInRow.isVisible().catch(() => false)) {
      await habilitadoInRow.click().catch(() => habilitadoInRow.click({ force: true }));
      await page.waitForTimeout(1_500);
    }

    const waitMsg = page.locator("text=/Por favor espere/i").first();
    if (await waitMsg.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Aceptar" }).click().catch(() => {});
      retryCount += 1;
      if (retryCount < ROUNDTABLE_MAX_RETRIES) await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
      continue;
    }

    console.log(`Rueda ${roundtableCode} abierta.`);
    return;
  }

  throw new Error(`No se pudo abrir la rueda ${roundtableCode} tras ${ROUNDTABLE_MAX_RETRIES} intentos.`);
}

async function waitForRonda2(page: Page): Promise<void> {
  // Wait until "Ronda 2" appears in the progress/timeline bar
  console.log("Esperando a que inicie Ronda 2...");
  const ronda2Indicator = page.getByText("Ronda 2", { exact: true }).first();
  await ronda2Indicator.waitFor({ state: "visible", timeout: 1_500_000 });
  await page.waitForTimeout(1_000);
  console.log("Ronda 2 detectada en barra de seguimiento.");
}

async function updateAllBids(
  page: Page,
  role: "buyer" | "seller",
  iterations: number,
  minutes: number,
  minAmount: number,
  maxAmount: number
): Promise<void> {
  // Total of `iterations` updates distributed over `minutes`
  const intervalMs = iterations > 1 ? Math.floor((minutes * 60_000) / iterations) : 0;

  for (let update = 0; update < iterations; update++) {
    if (update > 0 && intervalMs > 0) {
      console.log(`Esperando ${intervalMs / 1000}s antes de actualización ${update + 1}/${iterations}...`);
      await page.waitForTimeout(intervalMs);
    }

    // Pick icon cycling through available rows (round-robin)
    const icons = page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon").filter({ hasText: "edit" });
    const iconCount = await icons.count();
    if (iconCount === 0) {
      console.log(`No hay íconos de edición disponibles en actualización ${update + 1}.`);
      break;
    }
    const iconIndex = update % iconCount;

    await icons.nth(iconIndex).click();
    await page.waitForTimeout(500);

    // Form opens in mat-dialog-container
    const dialog = page.locator("mat-dialog-container").first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    // Scope to the specific form component
    const formScope = role === "seller"
      ? page.locator("app-modal-posture-for-sale")
      : page.locator("app-modal-posture-for-purchase, mat-dialog-container").first();

    // Capture current price before updating
    const priceField = formScope.getByRole("textbox", { name: "Precio ($/kWh)" });
    await priceField.click();
    const currentPriceRaw = await priceField.inputValue().catch(() => "");
    const currentPrice = parseFloat(currentPriceRaw.replace(/[^0-9.]/g, "")) || 0;

    // seller: random between min_amount and currentPrice (goes down)
    // buyer:  random between currentPrice and max_amount  (goes up)
    let newPrice: number;
    if (role === "seller") {
      const lo = Math.min(minAmount, currentPrice);
      const hi = Math.max(minAmount, currentPrice);
      newPrice = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    } else {
      const lo = Math.min(currentPrice, maxAmount);
      const hi = Math.max(currentPrice, maxAmount);
      newPrice = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }

    console.log(`Actualización ${update + 1}/${iterations} (fila ${iconIndex + 1}) — precio actual: ${currentPrice} → nuevo: ${newPrice}`);
    await priceField.fill(newPrice.toString());
    await page.waitForTimeout(200);

    if (role === "buyer") {
      const qtyField = formScope.getByRole("textbox", { name: "Cantidad (MW)" });
      if (await qtyField.isVisible().catch(() => false)) {
        await qtyField.click();
        await qtyField.fill(BID_QTY.toString());
        await page.waitForTimeout(200);
      }
      const mercadoSelect = formScope.locator("#destinyMarketId");
      if (await mercadoSelect.isVisible().catch(() => false)) {
        await mercadoSelect.selectOption("214");
        await page.waitForTimeout(200);
      }
    }

    const ofertarBtn = role === "seller"
      ? page.locator("app-modal-posture-for-sale").getByRole("button", { name: "Ofertar" })
      : page.locator("mat-dialog-container").getByRole("button", { name: "Ofertar" });
    await ofertarBtn.waitFor({ state: "visible", timeout: 8_000 });
    await ofertarBtn.click({ force: true });
    await page.waitForTimeout(1_000);

    const aceptarBtn = page.getByRole("button", { name: "Aceptar" });
    const aceptarVisible = await aceptarBtn.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
    if (aceptarVisible) await aceptarBtn.click();
    else await closeAcceptDialogIfVisible(page);
    await page.waitForTimeout(700);
  }

  console.log(`${iterations} actualizaciones de ${role} completadas en Ronda 2.`);
}

test.describe("Ronda 2 - Actualización de posturas", () => {
  test("seller: actualiza posturas de venta en Ronda 2", async ({ page }) => {
    test.setTimeout(1_500_000);

    const [seller] = await readActiveUsersByRole("seller");
    expect(seller, "Debe existir al menos un vendedor activo en data/users.csv").toBeDefined();

    await login(page, seller.username, seller.password);
    await enterRoundtable(page, seller.roundtable_code ?? ROUNDTABLE_CODE);
    await waitForRonda2(page);
    const iterations = Number(seller.iterations ?? 1);
    const minutes = Number(seller.minutes ?? 0);
    const minAmount = Number(seller.min_amount ?? 800);
    const maxAmount = Number(seller.max_amount ?? 1000);
    await updateAllBids(page, "seller", iterations, minutes, minAmount, maxAmount);
  });

  test("buyer: actualiza posturas de compra en Ronda 2", async ({ page }) => {
    test.setTimeout(1_500_000);

    const [buyer] = await readActiveUsersByRole("buyer");
    expect(buyer, "Debe existir al menos un comprador activo en data/users.csv").toBeDefined();

    await login(page, buyer.username, buyer.password);
    await enterRoundtable(page, buyer.roundtable_code ?? ROUNDTABLE_CODE);
    await waitForRonda2(page);
    const iterations = Number(buyer.iterations ?? 1);
    const minutes = Number(buyer.minutes ?? 0);
    const minAmount = Number(buyer.min_amount ?? 10);
    const maxAmount = Number(buyer.max_amount ?? 500);
    await updateAllBids(page, "buyer", iterations, minutes, minAmount, maxAmount);
  });
});
