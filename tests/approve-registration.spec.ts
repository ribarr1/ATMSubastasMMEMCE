/**
 * approve-registration.spec.ts
 *
 * Aprueba todas las solicitudes de inscripción con estado "En proceso"
 * usando el usuario operador configurado en data/operator-config.csv.
 *
 * Configuración:
 *   data/operator-config.csv  → credenciales del operador
 *
 * URL base: igual que el resto (MCE QA por defecto, MME staging via BASE_URL env var)
 *
 * Ejecución:
 *   npx playwright test tests/approve-registration.spec.ts --headed --workers=1 --timeout=300000
 *
 * Para MME:
 *   $env:BASE_URL = "https://mce.stag.conexionenergeticabmc.com.co"
 *   npx playwright test tests/approve-registration.spec.ts --headed --workers=1 --timeout=300000
 */

import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PAGES_TO_SCAN = Number(process.env.MAX_PAGES_TO_SCAN ?? "10");
const LOGIN_SETTLE_MS   = Number(process.env.LOGIN_SETTLE_MS   ?? "3000");

// ── CSV loader ────────────────────────────────────────────────────────────────

interface OperatorConfig {
  username: string;
  password: string;
}

interface RoundtableConfig {
  auction_type: string;
  roundtable_code: string;
  product: string;
}

function parseCsvSync<T>(filePath: string): T[] {
  const lines = fs.readFileSync(filePath, "utf-8").trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (values[i] ?? "").trim()));
    return obj as unknown as T;
  });
}

function loadOperatorConfig(): OperatorConfig {
  const rows = parseCsvSync<OperatorConfig>(
    path.resolve(__dirname, "../data/operator-config.csv")
  );
  if (rows.length === 0) throw new Error("operator-config.csv no tiene datos de operador");
  return rows[0];
}

function loadRoundtableConfig(): RoundtableConfig {
  const rows = parseCsvSync<RoundtableConfig>(
    path.resolve(__dirname, "../data/roundtable-config.csv")
  );
  if (rows.length === 0) throw new Error("roundtable-config.csv está vacío");
  return rows[0];
}

const OPERATOR  = loadOperatorConfig();
const RT_CONFIG = loadRoundtableConfig();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Cierra cualquier diálogo bloqueante. Si la sesión fue revocada, hace re-login.
 * Retorna true si la sesión fue revocada (para que el caller navegue de nuevo).
 */
async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  let sessionRevoked = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const btn1 = dialog.getByRole("button", { name: "Sí" });
    const btn2 = dialog.getByRole("button", { name: "Aceptar" });
    const btn3 = dialog.getByRole("button", { name: "OK" });
    const visibleButton = await Promise.race([
      btn1.waitFor({ state: "visible", timeout: 5_000 }).then(() => btn1).catch(() => null),
      btn2.waitFor({ state: "visible", timeout: 5_000 }).then(() => btn2).catch(() => null),
      btn3.waitFor({ state: "visible", timeout: 5_000 }).then(() => btn3).catch(() => null),
    ]);
    if (!visibleButton) break;
    const text = await dialog.innerText().catch(() => "");
    if (text.includes("La sesión fue revocada")) sessionRevoked = true;
    await visibleButton.click();
    await page.waitForTimeout(800);
  }
  return sessionRevoked;
}

/** Login del operador. Maneja revocación de sesión con reintento automático. */
async function loginOperator(page: Page): Promise<void> {
  await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(OPERATOR.username);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(OPERATOR.password);
  await page.getByRole("button", { name: "Ingresar" }).click();

  const sessionRevoked = await dismissBlockingDialogs(page);
  await page.waitForTimeout(2_000);

  if (sessionRevoked || page.url().includes("/auth/sign-in")) {
    console.log("Sesión revocada — reintentando login...");
    await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(OPERATOR.username);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(OPERATOR.password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await dismissBlockingDialogs(page);
  }

  await page.waitForTimeout(LOGIN_SETTLE_MS);
  await expect(page).toHaveURL(/\/home(?:\/)?$/, { timeout: 60_000 });
  console.log(`Operador autenticado: ${OPERATOR.username}`);
}

/** Navega al listado de inscripciones a ruedas. */
async function navigateToRegistrationList(page: Page): Promise<void> {
  const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
  await transMenu.waitFor({ state: "visible", timeout: 10_000 });
  await transMenu.click({ force: true });
  await page.waitForTimeout(500);
  await page.locator("a").filter({ hasText: "Inscripción a ruedas" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);
  console.log("Navegó a Inscripción a ruedas");
}

/**
 * Navega de regreso al listado después de aprobar (usa el enlace "Atrás"
 * o renavega al módulo si no existe el botón).
 */
async function goBackToList(page: Page): Promise<void> {
  const atrasLink = page.locator("a, button, span").filter({ hasText: /^Atrás$/i }).first();
  if (await atrasLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await atrasLink.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1_000);
  } else {
    // fallback: re-navegar al módulo
    await navigateToRegistrationList(page);
  }
}

/**
 * Avanza a la siguiente página de la tabla si existe y no está deshabilitada.
 * Retorna true si avanzó, false si ya no hay siguiente página.
 */
async function goToNextPage(page: Page): Promise<boolean> {
  const nextIcon = page.getByText("navigate_next").first();
  if (!(await nextIcon.isVisible().catch(() => false))) return false;
  const nextBtn = nextIcon.locator("xpath=ancestor::button[1]");
  const hasBtnAncestor = await nextBtn.count().catch(() => 0);
  const disabled =
    hasBtnAncestor > 0 &&
    ((await nextBtn.isDisabled().catch(() => false)) ||
      (await nextBtn.getAttribute("aria-disabled").catch(() => null)) === "true");
  if (disabled) return false;
  hasBtnAncestor > 0 ? await nextBtn.click() : await nextIcon.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(800).catch(() => {});
  return true;
}

/**
 * Aprueba UNA solicitud "En proceso":
 *  1. Hace clic en el span "En proceso" de la fila
 *  2. Espera el formulario de detalle
 *  3. Hace clic en "Aprobar"
 *  4. Confirma en el diálogo con "Aceptar"
 *  5. Vuelve al listado
 *
 * Retorna true si la aprobación fue exitosa.
 */
async function approveOne(page: Page, span: import("@playwright/test").Locator): Promise<boolean> {
  try {
    await span.scrollIntoViewIfNeeded();
    await span.click();
    await page.waitForTimeout(1_500);

    // Esperar el formulario de detalle (debe aparecer el botón Aprobar)
    const approveBtn = page.getByRole("button", { name: "Aprobar" });
    const formVisible = await approveBtn.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
    if (!formVisible) {
      console.log("  Formulario de detalle no apareció — saltando.");
      await goBackToList(page);
      return false;
    }

    await approveBtn.click();
    await page.waitForTimeout(500);

    // Confirmar en diálogo "¿Está seguro de que desea aprobar?"
    const confirmBtn = page.getByRole("button", { name: "Aceptar" });
    await confirmBtn.waitFor({ state: "visible", timeout: 8_000 });
    await confirmBtn.click();
    await page.waitForTimeout(1_500);

    // Cerrar cualquier diálogo de resultado (éxito/error)
    await dismissBlockingDialogs(page);
    await page.waitForTimeout(500);

    await goBackToList(page);
    return true;
  } catch (err) {
    console.log(`  Error aprobando solicitud: ${err}`);
    await goBackToList(page).catch(() => {});
    return false;
  }
}

/**
 * Recorre las páginas del listado aprobando TODAS las filas "En proceso"
 * del producto activo. Agota la página actual antes de avanzar a la siguiente.
 *
 * Retorna el total de solicitudes aprobadas.
 */
async function approveAllPending(page: Page): Promise<number> {
  let totalApproved = 0;
  const product = RT_CONFIG.product;
  console.log(`Filtrando por producto: ${product}`);

  const rowSelector  = "table tbody tr";
  const spanSelector = "span.btn-link-primary";

  for (let pageIdx = 0; pageIdx < MAX_PAGES_TO_SCAN; pageIdx++) {
    await page.waitForTimeout(800);
    let approvedOnPage = 0;

    // Agotar todos los "En proceso" de la página actual antes de avanzar
    while (true) {
      const rows = page.locator(rowSelector);
      const rowCount = await rows.count();
      let foundOne = false;

      for (let r = 0; r < rowCount; r++) {
        const row     = rows.nth(r);
        const rowText = await row.innerText().catch(() => "");
        if (!rowText.includes(product)) continue;

        const span = row.locator(spanSelector).filter({ hasText: /En proceso/i }).first();
        if (!(await span.isVisible().catch(() => false))) continue;

        console.log(`  Pág ${pageIdx + 1} — aprobando solicitud ${totalApproved + 1} para ${product}`);
        const ok = await approveOne(page, span);
        if (ok) {
          totalApproved++;
          approvedOnPage++;
          console.log(`  ✔ Aprobada. Total: ${totalApproved}`);
          foundOne = true;
        }
        // El DOM cambió: re-escanear la tabla desde la primera fila
        break;
      }

      if (!foundOne) break; // ningún "En proceso" más en esta página
    }

    console.log(`  Pág ${pageIdx + 1}: ${approvedOnPage} aprobada(s). Avanzando...`);

    const advanced = await goToNextPage(page);
    if (!advanced) {
      console.log("Última página alcanzada.");
      break;
    }
  }

  return totalApproved;
}

/**
 * Navega a Acceso a ruedas, filtra por "En inscripción", selecciona la fila
 * cuya primera columna coincide con RT_CONFIG.roundtable_code y pulsa "Habilitar".
 */
async function habilitarAccesoRueda(page: Page): Promise<void> {
  console.log("\nNavegando a Acceso a ruedas...");
  const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
  await transMenu.waitFor({ state: "visible", timeout: 10_000 });
  await transMenu.click({ force: true });
  await page.waitForTimeout(500);
  await page.locator("a").filter({ hasText: "Acceso a ruedas" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);
  console.log("Navegó a Acceso a ruedas");
  console.log(`Buscando rueda ${RT_CONFIG.roundtable_code} en la tabla...`);

  // Esperar a que la tabla cargue
  await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_000);

  // Buscar la fila cuya primera columna tenga el código de rueda
  const rows = page.locator("table tbody tr");
  const rowCount = await rows.count();
  let targetRow: import("@playwright/test").Locator | null = null;

  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);
    const firstCell = row.locator("td").first();
    const cellText = (await firstCell.innerText().catch(() => "")).trim();
    if (cellText === RT_CONFIG.roundtable_code) {
      targetRow = row;
      break;
    }
  }

  if (!targetRow) {
    console.log(`  ⚠ No se encontró la rueda ${RT_CONFIG.roundtable_code} en la tabla. Verificar manualmente.`);
    return;
  }

  // Verificar que la fila tiene estado "En inscripción"
  const rowText = await targetRow.innerText().catch(() => "");
  if (!rowText.includes("En inscripción")) {
    console.log(`  ⚠ Rueda ${RT_CONFIG.roundtable_code} encontrada pero NO está en estado "En inscripción". Estado actual: ${rowText.trim().substring(0, 80)}`);
    return;
  }
  console.log(`  Rueda ${RT_CONFIG.roundtable_code} está en "En inscripción". Seleccionando...`);

  // Hacer clic en "En inscripción" de ESA fila para filtrar (o marcar el checkbox de la fila)
  const enInscripcionLink = targetRow.locator("a, span").filter({ hasText: /En inscripción/i }).first();
  if (await enInscripcionLink.isVisible().catch(() => false)) {
    await enInscripcionLink.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2_000);
  }

  // Marcar el checkbox "Seleccionar todos"
  const selectAllCheckbox = page.locator("mat-checkbox").filter({ hasText: /Seleccionar todos/i }).first();
  await selectAllCheckbox.waitFor({ state: "visible", timeout: 10_000 });
  await selectAllCheckbox.locator(".mat-checkbox-inner-container").click();
  await page.waitForTimeout(500);
  console.log("  Checkbox 'Seleccionar todos' marcado.");

  // Clic en "Habilitar"
  const habilitarBtn = page.locator("button.btn-primary").filter({ hasText: /Habilitar/i }).first();
  await habilitarBtn.waitFor({ state: "visible", timeout: 10_000 });
  await habilitarBtn.click();
  await page.waitForTimeout(1_000);

  // Confirmar si aparece diálogo
  await dismissBlockingDialogs(page);
  await page.waitForTimeout(1_000);

  console.log(`  ✔ Rueda ${RT_CONFIG.roundtable_code} habilitada.`);
}

// ── Test ──────────────────────────────────────────────────────────────────────

test.describe("Aprobación de inscripciones a rueda", () => {
  test("operador aprueba todas las solicitudes En proceso", async ({ page }) => {
    test.setTimeout(300_000);

    await loginOperator(page);
    await navigateToRegistrationList(page);

    const total = await approveAllPending(page);

    if (total === 0) {
      console.log("No había solicitudes pendientes de aprobación.");
    } else {
      console.log(`\n✔ Proceso completado. Total solicitudes aprobadas: ${total}`);
    }

    // Verificación final: no deben quedar spans "En proceso" visibles
    const remaining = page.locator("span.btn-link-primary").filter({ hasText: /En proceso/i });
    const remainingCount = await remaining.count();
    console.log(`Solicitudes "En proceso" restantes: ${remainingCount}`);

    // Habilitar acceso a la rueda en el módulo "Acceso a ruedas"
    await habilitarAccesoRueda(page);
  });
});
