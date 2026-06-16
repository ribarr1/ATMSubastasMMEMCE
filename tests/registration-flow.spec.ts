import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import type { MmeUser, RoundtableConfig } from "../src/types";

// ── Constants ────────────────────────────────────────────────────────────────

const LOGIN_SETTLE_MS          = Number(process.env.LOGIN_SETTLE_MS          ?? "3000");
const MAX_PAGES_TO_SCAN        = Number(process.env.MAX_PAGES_TO_SCAN        ?? "100");

// ── Sync CSV loaders ─────────────────────────────────────────────────────────

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

function loadMmeUsersCsvSync(): MmeUser[] {
  return parseCsvSync<MmeUser>(
    path.resolve(__dirname, "../data/mme-users.csv")
  ).filter((u) => u.active === "true");
}

function loadRoundtableConfig(): RoundtableConfig {
  const rows = parseCsvSync<RoundtableConfig>(
    path.resolve(__dirname, "../data/roundtable-config.csv")
  );
  if (rows.length === 0) throw new Error("roundtable-config.csv está vacío");
  return rows[0];
}

const ALL_USERS    = loadMmeUsersCsvSync();
const RT_CONFIG    = loadRoundtableConfig();

// ── Types ────────────────────────────────────────────────────────────────────

type RoundtableLookupStatus = "form" | "already-registered" | "not-found";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  let sessionRevoked = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const btn1 = dialog.getByRole("button", { name: "Sí"      });
    const btn2 = dialog.getByRole("button", { name: "Aceptar" });
    const btn3 = dialog.getByRole("button", { name: "OK"      });
    const visibleButton = await Promise.race([
      btn1.waitFor({ state: "visible", timeout: 8_000 }).then(() => btn1).catch(() => null),
      btn2.waitFor({ state: "visible", timeout: 8_000 }).then(() => btn2).catch(() => null),
      btn3.waitFor({ state: "visible", timeout: 8_000 }).then(() => btn3).catch(() => null),
    ]);
    if (!visibleButton) break;
    const text = await dialog.innerText().catch(() => "");
    if (text.includes("La sesión fue revocada")) sessionRevoked = true;
    await visibleButton.click();
    await page.waitForTimeout(1_000);
  }
  return sessionRevoked;
}

/**
 * Login MME: selecciona rol "Negociador" si el usuario tiene múltiples roles.
 */
async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();

  // Selección de rol (aparece cuando el usuario tiene más de un rol)
  const roleSelector = page.getByLabel("").locator("div").nth(3);
  if (await roleSelector.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false)) {
    await roleSelector.click();
    await page.getByRole("option", { name: "Negociador" }).locator("span").click();
    console.log(`Rol "Negociador" seleccionado para ${username}`);
  }

  const sessionRevoked = await dismissBlockingDialogs(page);
  await page.waitForTimeout(2_000);

  if (sessionRevoked || page.url().includes("/auth/sign-in")) {
    await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    const rs2 = page.getByLabel("").locator("div").nth(3);
    if (await rs2.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false)) {
      await rs2.click();
      await page.getByRole("option", { name: "Negociador" }).locator("span").click();
    }
    await dismissBlockingDialogs(page);
  }

  await page.waitForTimeout(LOGIN_SETTLE_MS);
  await expect(page).toHaveURL(/\/home(?:\/)?$/, { timeout: 60_000 });
}

async function openRoundtableRegistration(page: Page): Promise<void> {
  const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
  await transMenu.waitFor({ state: "visible", timeout: 10_000 });
  await transMenu.click({ force: true });
  await page.waitForTimeout(500);
  await page.locator("a").filter({ hasText: "Inscripción a ruedas" }).click();
  await expect(page).toHaveURL(/\/transational\/roundtable-registration$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Inscripción a rueda" })).toBeVisible();
  await page.getByRole("button", { name: "Solicitar inscripción" }).click();
  await page.waitForLoadState("networkidle").catch(() => {});
}

/**
 * Busca en la tabla de ruedas disponibles la que coincide con el producto del config.
 * Retorna: "form" (abre formulario), "already-registered" o "not-found".
 */
async function findAssignableRoundtable(page: Page, product: string): Promise<RoundtableLookupStatus> {
  const roundtableCode = product;
  const modal = page.getByRole("dialog");
  await page.waitForTimeout(2_000);

  const rows = page.locator("table tbody tr");
  let lastPageSignature = "";

  for (let pageIndex = 0; pageIndex < MAX_PAGES_TO_SCAN; pageIndex++) {
    const rowCount = await rows.count();
    console.log(`Página ${pageIndex + 1}: ${rowCount} filas`);

    const firstRowText = rowCount > 0 ? await rows.first().innerText().catch(() => "") : "";
    const pageSignature = `${rowCount}::${firstRowText}`;
    if (pageIndex > 0 && pageSignature === lastPageSignature) {
      console.log("Misma página detectada — fin de paginación.");
      break;
    }
    lastPageSignature = pageSignature;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const row  = rows.nth(rowIndex);
      const text = await row.innerText().catch(() => "");
      if (!text.includes(roundtableCode)) continue;

      console.log(`Rueda ${roundtableCode} encontrada en página ${pageIndex + 1}, fila ${rowIndex + 1}`);

      const evaluateOutcome = async (): Promise<RoundtableLookupStatus | null> => {
        if (await page.locator("#minimumHour").isVisible().catch(() => false)) return "form";
        if (await modal.isVisible().catch(() => false)) {
          const modalText = await modal.innerText().catch(() => "");
          if (modalText.includes("Ya se encuentra registrada una solicitud de inscripción")) {
            await modal.getByRole("button", { name: "Aceptar" }).click();
            await page.waitForTimeout(1_000);
            return "already-registered";
          }
          return "not-found";
        }
        return null;
      };

      // Intentar clic en celda con el código
      const codeCell = row.getByText(roundtableCode, { exact: false }).first();
      if (await codeCell.isVisible().catch(() => false)) {
        await codeCell.click().catch(() => codeCell.click({ force: true }));
        await page.waitForTimeout(1_500);
        const outcome = await evaluateOutcome();
        if (outcome) return outcome;
      }

      // Intentar clic en el último control de acción de la fila
      const actionControl = row.locator("a, button").last();
      if (await actionControl.isVisible().catch(() => false)) {
        await actionControl.click().catch(() => actionControl.click({ force: true }));
        await page.waitForTimeout(1_500);
        const outcome = await evaluateOutcome();
        if (outcome) return outcome;
      }

      // Fallback: clic en la fila entera
      await row.click().catch(() => row.click({ force: true }));
      await page.waitForTimeout(1_500);
      const outcome = await evaluateOutcome();
      if (outcome) return outcome;
    }

    // Siguiente página
    const nextIcon = page.getByText("navigate_next").first();
    if (!(await nextIcon.isVisible().catch(() => false))) { console.log("Sin botón siguiente."); break; }
    const nextBtn = nextIcon.locator("xpath=ancestor::button[1]");
    const hasBtnAncestor = await nextBtn.count().catch(() => 0);
    const disabled =
      (hasBtnAncestor > 0 && await nextBtn.isDisabled().catch(() => false)) ||
      (hasBtnAncestor > 0 && (await nextBtn.getAttribute("aria-disabled").catch(() => null)) === "true");
    if (disabled) { console.log("Última página alcanzada."); break; }
    hasBtnAncestor > 0 ? await nextBtn.click() : await nextIcon.click();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
  }

  console.log(`Rueda ${roundtableCode} no encontrada tras paginar.`);
  return "not-found";
}

// ── Tests: un test por fila activa en mme-users.csv ─────────────────────────

test.describe("Inscripción a rueda MME", () => {
  for (const user of ALL_USERS) {
    const label = `${user.role} - ${user.username} (rueda ${RT_CONFIG.roundtable_code})`;
    test(label, async ({ page }) => {
      test.setTimeout(300_000);

      await login(page, user.username, user.password);
      await openRoundtableRegistration(page);

      const status = await findAssignableRoundtable(page, RT_CONFIG.product);

      if (status === "not-found") {
        console.log(`Producto ${RT_CONFIG.product} no disponible para ${user.username} — omitiendo.`);
        test.skip(true, `Producto ${RT_CONFIG.product} no encontrado en la lista de inscripción.`);
        return;
      }

      if (status === "already-registered") {
        console.log(`${user.username} ya tiene solicitud registrada (${RT_CONFIG.product}).`);
        return;
      }

      // Formulario de garantías
      await expect(page.locator("#minimumHour")).toBeVisible({ timeout: 10_000 });

      // MCE: #minimumHour es el tipo de operación (Compra=0 / Vende=1)
      // MME: el campo no aplica, se omite
      if (RT_CONFIG.auction_type === "MCE") {
        const opValue = user.role === "buyer" ? "0" : "1";
        const opLabel = user.role === "buyer" ? "Compra" : "Vende";
        await page.locator("#minimumHour").selectOption(opValue);
        console.log(`Tipo de operación seleccionado: ${opLabel} para ${user.username}`);
      }

      await page.locator(".mat-checkbox-inner-container").first().click();
      await page.getByRole("button", { name: "Asignar garantías" }).click();
      await page.getByRole("button", { name: "Aceptar" }).click();
      console.log(`Inscripción completada: ${user.username} → ${RT_CONFIG.product} (${RT_CONFIG.auction_type})`);
    });
  }
});

