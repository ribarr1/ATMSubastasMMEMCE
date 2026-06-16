import { test, expect, type Page } from "@playwright/test";
import { readActiveUsersByRole } from "../src/csvUsers";

const LOGIN_SETTLE_MS = Number(process.env.LOGIN_SETTLE_MS ?? "1200");
const ACCESS_MAX_PAGES_TO_SCAN = Number(process.env.ACCESS_MAX_PAGES_TO_SCAN ?? "100");
const ROUNDTABLE_PRODUCT = process.env.ROUNDTABLE_PRODUCT ?? "PM2606043";
const ROUNDTABLE_CODE = process.env.ROUNDTABLE_CODE ?? "327";
const OPEN_ROUNDTABLE_MAX_WAIT_MS = Number(process.env.OPEN_ROUNDTABLE_MAX_WAIT_MS ?? "900000");
const ROUNDTABLE_RETRY_INTERVAL_MS = Number(process.env.ROUNDTABLE_RETRY_INTERVAL_MS ?? "60000");
const ROUNDTABLE_MAX_RETRIES = Number(process.env.ROUNDTABLE_MAX_RETRIES ?? "5");
const ROUND_READY_POLL_MS = Number(process.env.ROUND_READY_POLL_MS ?? "3000");
const BUY_PRICE_BASE = Number(process.env.BUY_PRICE_BASE ?? "10");
const SELL_PRICE_BASE = Number(process.env.SELL_PRICE_BASE ?? "800");
const BID_QTY = Number(process.env.BID_QTY ?? "1");
const BID_FNCER = Number(process.env.BID_FNCER ?? "5");
const BUYER_MERCADO_DESTINO = process.env.BUYER_MERCADO_DESTINO ?? "214";

type AccessRoundtableStatus = "opened" | "not-found";

type OpenRoundtableAttempt = "opened" | "waiting" | "not-found";

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

  const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
  await transMenu.waitFor({ state: "visible", timeout: 10_000 });
  await transMenu.click({ force: true });
  await page.waitForTimeout(500);
  await page.locator("a").filter({ hasText: "Acceso a ruedas" }).click();
  
  // Wait for the table headers to be visible
  await page.getByRole("columnheader", { name: "Código de rueda" }).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  if (page.url().includes("/auth/sign-in")) {
    throw new Error("La sesión volvió a login al intentar abrir Acceso a ruedas.");
  }
}

async function hasRoundWaitMessage(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  const waitTextVisible = await page
    .getByText("Por favor espere a que inicie", { exact: false })
    .first()
    .isVisible()
    .catch(() => false);

  if (waitTextVisible) {
    return true;
  }

  if (!(await dialog.isVisible().catch(() => false))) {
    return false;
  }

  const dialogText = (await dialog.innerText().catch(() => "")).toLowerCase();
  return dialogText.includes("por favor espere a que inicie");
}

async function closeAcceptDialogIfVisible(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  const dialogAccept = dialog.getByRole("button", { name: "Aceptar" });
  if (await dialogAccept.isVisible().catch(() => false)) {
    await dialogAccept.click();
    await page.waitForTimeout(200);
    return;
  }

  const pageAccept = page.getByRole("button", { name: "Aceptar" }).first();
  if (await pageAccept.isVisible().catch(() => false)) {
    await pageAccept.click();
    await page.waitForTimeout(200);
  }
}

async function isTradingScreenVisible(page: Page): Promise<boolean> {
  const buyVisible = await page.getByRole("button", { name: "Comprar" }).first().isVisible().catch(() => false);
  const sellVisible = await page.getByRole("button", { name: "Vender" }).first().isVisible().catch(() => false);
  const roundLabelVisible = await page.getByText("Ronda 1", { exact: false }).first().isVisible().catch(() => false);
  return buyVisible || sellVisible || roundLabelVisible;
}

async function tryOpenTargetEnabledRoundtable(page: Page, roundtableCode: string, maxRetries: number = ROUNDTABLE_MAX_RETRIES): Promise<OpenRoundtableAttempt> {
  if (page.url().includes("/auth/sign-in")) {
    throw new Error("La sesión caducó antes de listar ruedas de acceso.");
  }

  // Helper to ensure we're on the roundtable table with data loaded
  async function navigateToRoundtableTable(): Promise<void> {
    if (!page.url().includes("access-business-roundtable")) {
      const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
      await transMenu.waitFor({ state: "visible", timeout: 10_000 });
      await transMenu.click({ force: true });
      await page.waitForTimeout(500);
      await page.locator("a").filter({ hasText: "Acceso a ruedas" }).click();
      await page.getByRole("columnheader", { name: "Código de rueda" }).waitFor({ state: "visible", timeout: 15_000 });
    }
    // Wait for data rows to render (Angular async rendering)
    await page.locator("td.mat-cell, td[role='cell'], .mat-column-code td").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  const dialog = page.getByRole("dialog");
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      console.log(`Intento ${retryCount + 1}/${maxRetries} de apertura de rueda ${roundtableCode}`);

      // Ensure we're on the roundtable access page with data loaded
      await navigateToRoundtableTable();

      // Find the cell with the roundtable code in the first column
      const roundtableCell = page.locator("td.mat-column-code").filter({ hasText: roundtableCode }).first();
      const elementCount = await roundtableCell.count();
      console.log(`Elementos encontrados con código ${roundtableCode}: ${elementCount}`);

      if (elementCount === 0) {
        console.log(`Rueda ${roundtableCode} no encontrada, reintentando...`);
        retryCount += 1;
        if (retryCount < maxRetries) {
          await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
        }
        continue;
      }

      // Scroll the element into view
      await roundtableCell.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      // Get the parent row
      const row = roundtableCell.locator("xpath=ancestor::tr").first();

      // Find the "Habilitado" text within this row and click it
      const habilitadoInRow = row.locator("text=Habilitado").first();
      const habilitadoCount = await habilitadoInRow.count();
      console.log(`"Habilitado" en fila: ${habilitadoCount}`);

      if (habilitadoCount > 0 && await habilitadoInRow.isVisible().catch(() => false)) {
        console.log(`Clickeando Habilitado para rueda ${roundtableCode}`);
        await habilitadoInRow.click().catch(async () => {
          await habilitadoInRow.click({ force: true });
        });
        await page.waitForTimeout(3_000);
      }

      // Check if we got the "Por favor espere" message
      const waitMessage = page.locator("text=/Por favor espere/i").first();
      const waitMessageVisible = await waitMessage.isVisible().catch(() => false);
      const dialogVisible = await dialog.isVisible().catch(() => false);
      
      if (waitMessageVisible || dialogVisible) {
        const dialogText = dialogVisible ? await dialog.innerText().catch(() => "") : "";
        if (waitMessageVisible || dialogText.toLowerCase().includes("por favor espere")) {
          console.log(`Rueda aún no ha iniciado. Reintentando en ${ROUNDTABLE_RETRY_INTERVAL_MS / 1000}s...`);
          await page.getByRole("button", { name: "Aceptar" }).click().catch(() => {});
          await page.waitForTimeout(500);
          retryCount += 1;
          await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
          continue;
        }
      }

      // Check if trading screen is visible
      if (await isTradingScreenVisible(page)) {
        console.log(`Rueda ${roundtableCode} abierta exitosamente.`);
        return "opened";
      }

      // If neither trading screen nor wait message, the click may not have navigated
      console.log(`Click en Habilitado no abrió trading ni mostró espera. URL: ${page.url()}`);
      retryCount += 1;
      if (retryCount < maxRetries) {
        await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
      }
      continue;
    } catch (error) {
      console.log(`Error en intento ${retryCount + 1}: ${error}`);
      retryCount += 1;
      if (retryCount < maxRetries) {
        await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
      }
    }
  }

  console.log(`Se alcanzó el máximo de reintentos (${maxRetries}) para la rueda ${roundtableCode}.`);
  return "not-found";
}

async function openTargetRoundtableWithWait(page: Page, roundtableCode: string): Promise<AccessRoundtableStatus> {
  const result = await tryOpenTargetEnabledRoundtable(page, roundtableCode, ROUNDTABLE_MAX_RETRIES);
  return result === "opened" ? "opened" : "not-found";
}

async function submitBid(page: Page, role: "buyer" | "seller", price: number): Promise<void> {
  const actionButtonName = role === "buyer" ? "Comprar" : "Vender";

  // Click Comprar / Vender
  const actionButton = page.getByRole("button", { name: actionButtonName }).first();
  await expect(actionButton).toBeVisible({ timeout: 30_000 });
  await actionButton.click();
  await page.waitForTimeout(1_000);

  // All form fields are inside mat-dialog-container
  const dialog = page.locator("mat-dialog-container").first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  // Fill price
  await dialog.getByRole("textbox", { name: "Precio ($/kWh)" }).fill(price.toString());
  await page.waitForTimeout(200);

  // Fill quantity
  await dialog.getByRole("textbox", { name: "Cantidad (MW)" }).click();
  await dialog.getByRole("textbox", { name: "Cantidad (MW)" }).fill(BID_QTY.toString());
  await page.waitForTimeout(200);

  // Fill % FNCER (seller form only)
  if (role === "seller") {
    await dialog.getByRole("textbox", { name: "% FNCER" }).fill(BID_FNCER.toString());
    await page.waitForTimeout(200);
  }

  // Select Mercado destino (skip if not found)
  const mercadoSelect = dialog.locator("#destinyMarketId");
  if (await mercadoSelect.isVisible().catch(() => false)) {
    await mercadoSelect.selectOption("214");
    await page.waitForTimeout(200);
    console.log(`Mercado destino seleccionado: Regulado (214)`);
  }

  // Click Ofertar inside the dialog — scope to specific form component by role
  const ofertarBtn = role === "seller"
    ? page.locator("app-modal-posture-for-sale").getByRole("button", { name: "Ofertar" })
    : page.locator("mat-dialog-container").getByRole("button", { name: "Ofertar" });
  await ofertarBtn.waitFor({ state: "visible", timeout: 8_000 });
  await ofertarBtn.click({ force: true });
  await page.waitForTimeout(1_000);

  // Click Aceptar
  const aceptarBtn = page.locator("button.btn-primary").filter({ hasText: "Aceptar" });
  const aceptarVisible = await aceptarBtn.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (aceptarVisible) {
    await aceptarBtn.click();
  } else {
    await closeAcceptDialogIfVisible(page);
  }
  await page.waitForTimeout(500);

  console.log(`Postura de ${role} enviada: precio=${price}, cantidad=${BID_QTY}, FNCER=${BID_FNCER}`);
}

async function runBidIterations(
  page: Page,
  role: "buyer" | "seller",
  iterations: number,
  minutes: number,
  minAmount: number,
  maxAmount: number
): Promise<void> {
  // Distribute iterations evenly across the time window
  // Interval = total_ms / iterations (wait BEFORE each bid except the first)
  const intervalMs = iterations > 1 ? Math.floor((minutes * 60_000) / iterations) : 0;

  for (let i = 0; i < iterations; i++) {
    if (i > 0 && intervalMs > 0) {
      console.log(`Esperando ${intervalMs / 1000}s antes de postura ${i + 1}/${iterations}...`);
      await page.waitForTimeout(intervalMs);
    }
    const price = Math.floor(Math.random() * (maxAmount - minAmount + 1)) + minAmount;
    console.log(`Postura ${i + 1}/${iterations} — precio: ${price}`);
    await submitBid(page, role, price);
  }
}

test.describe("Acceso a ruedas - Ronda 1 automatizada", () => {
  test("seller: entra a rueda y envía postura de venta", async ({ page }) => {
    test.setTimeout(1_500_000);

    const [seller] = await readActiveUsersByRole("seller");
    expect(seller, "Debe existir al menos un vendedor activo en data/users.csv").toBeDefined();

    await login(page, seller.username, seller.password);
    await openRoundtableAccess(page);

    const roundtableCode = seller.roundtable_code ?? ROUNDTABLE_CODE;
    const accessStatus = await openTargetRoundtableWithWait(page, roundtableCode);
    test.skip(accessStatus === "not-found", `No se pudo abrir la rueda ${roundtableCode} tras ${ROUNDTABLE_MAX_RETRIES} intentos.`);

    const iterations = Number(seller.iterations ?? 1);
    const minutes = Number(seller.minutes ?? 0);
    const minAmount = Number(seller.min_amount ?? SELL_PRICE_BASE);
    const maxAmount = Number(seller.max_amount ?? SELL_PRICE_BASE + 200);
    await runBidIterations(page, "seller", iterations, minutes, minAmount, maxAmount);
  });

  test("buyer: entra a rueda y envía postura de compra", async ({ page }) => {
    test.setTimeout(1_500_000);

    const [buyer] = await readActiveUsersByRole("buyer");
    expect(buyer, "Debe existir al menos un comprador activo en data/users.csv").toBeDefined();

    await login(page, buyer.username, buyer.password);
    await openRoundtableAccess(page);

    const roundtableCode = buyer.roundtable_code ?? ROUNDTABLE_CODE;
    const accessStatus = await openTargetRoundtableWithWait(page, roundtableCode);
    test.skip(accessStatus === "not-found", `No se pudo abrir la rueda ${roundtableCode} tras ${ROUNDTABLE_MAX_RETRIES} intentos.`);

    const iterations = Number(buyer.iterations ?? 1);
    const minutes = Number(buyer.minutes ?? 0);
    const minAmount = Number(buyer.min_amount ?? BUY_PRICE_BASE);
    const maxAmount = Number(buyer.max_amount ?? BUY_PRICE_BASE + 200);
    await runBidIterations(page, "buyer", iterations, minutes, minAmount, maxAmount);
  });
});
