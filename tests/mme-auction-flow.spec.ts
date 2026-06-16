/**
 * mme-auction-flow.spec.ts
 *
 * Orquesta una subasta completa MME (2-3 rondas) para buyers y sellers en paralelo.
 * Diferencias con MCE (full-auction-flow.spec.ts):
 *   - Login requiere selección de rol "Negociador" tras autenticarse
 *   - Formulario de venta tiene campos adicionales: Cantidad mínima (MW) y Proyecto*
 *   - Los proyectos usados se deshabilitan — se elige el primer disponible por postura
 *   - URL base: https://mce.stag.conexionenergeticabmc.com.co
 *
 * Configuración:
 *   data/mme-users.csv  → credenciales + parámetros por ronda
 *   data/rounds.csv     → duración y espera entre rondas (se reutiliza)
 */

import { test, expect, type Page } from "@playwright/test";
import { readRounds } from "../src/csvRounds";
import type { RoundConfig, MmeUser, RoundtableConfig } from "../src/types";
import fs from "fs";
import path from "path";

// ── Sync CSV loaders ──────────────────────────────────────────────────────────

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

const ALL_USERS  = loadMmeUsersCsvSync();
const RT_CONFIG  = loadRoundtableConfig();

// ── Constants ────────────────────────────────────────────────────────────────

const LOGIN_SETTLE_MS   = Number(process.env.LOGIN_SETTLE_MS   ?? "1200");
const ROUNDTABLE_RETRY_INTERVAL_MS = Number(process.env.ROUNDTABLE_RETRY_INTERVAL_MS ?? "60000");
const ROUNDTABLE_MAX_RETRIES       = Number(process.env.ROUNDTABLE_MAX_RETRIES       ?? "5");
const BID_QTY           = Number(process.env.BID_QTY     ?? "1");
const BID_QTY_MIN       = Number(process.env.BID_QTY_MIN ?? "1");   // Cantidad mínima seller
const BID_FNCER         = Number(process.env.BID_FNCER   ?? "1");

// ── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toLocaleString("es-CO", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  console.log(`[${ts}] ${msg}`);
}

// ── Round params ─────────────────────────────────────────────────────────────

interface RoundUserParams { iterations: number; min: number; max: number; }

function getRoundParams(user: MmeUser, roundNumber: number): RoundUserParams {
  const key = `r${roundNumber}` as `r${1 | 2 | 3}`;
  return {
    iterations: Number(user[`${key}_iterations`] ?? 0),
    min:        Number(user[`${key}_min`]        ?? 0),
    max:        Number(user[`${key}_max`]        ?? 0),
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  let sessionRevoked = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const yesBtn    = dialog.getByRole("button", { name: "Sí" });
    const acceptBtn = dialog.getByRole("button", { name: "Aceptar" });
    const okBtn     = dialog.getByRole("button", { name: "OK" });
    const btn = await Promise.race([
      yesBtn.waitFor({ state: "visible", timeout: 8_000 }).then(() => yesBtn).catch(() => null),
      acceptBtn.waitFor({ state: "visible", timeout: 8_000 }).then(() => acceptBtn).catch(() => null),
      okBtn.waitFor({ state: "visible", timeout: 8_000 }).then(() => okBtn).catch(() => null),
    ]);
    if (!btn) break;
    const text = await dialog.innerText().catch(() => "");
    if (text.includes("La sesión fue revocada")) sessionRevoked = true;
    await btn.click();
    await page.waitForTimeout(700);
  }
  return sessionRevoked;
}

/**
 * Login para MME: después de autenticarse aparece un selector de rol.
 * Se debe elegir "Negociador".
 */
async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "ID/Nombre de usuario" }).fill(username);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();

  // Selector de rol — aparece cuando el usuario tiene múltiples roles
  const roleSelector = page.getByLabel("").locator("div").nth(3);
  const roleVisible = await roleSelector.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false);
  if (roleVisible) {
    await roleSelector.click();
    await page.getByRole("option", { name: "Negociador" }).locator("span").click();
    log(`Rol "Negociador" seleccionado para ${username}`);
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
  await expect(page).toHaveURL(/\/home(?:\/)?$/, { timeout: 30_000 });
}

// ── Navigation ───────────────────────────────────────────────────────────────

async function closeAcceptDialogIfVisible(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) return;
  const btn = dialog.getByRole("button", { name: /Aceptar|OK/i });
  if (await btn.isVisible().catch(() => false)) await btn.click();
  await page.waitForTimeout(300);
}

async function openRoundtable(page: Page, roundtableCode: string): Promise<void> {
  async function navigateToRoundtableTable(): Promise<void> {
    if (!page.url().includes("access-business-roundtable")) {
      const transMenu = page.locator("a").filter({ hasText: "Transaccional" });
      await transMenu.waitFor({ state: "visible", timeout: 10_000 });
      await transMenu.click({ force: true });
      await page.waitForTimeout(500);
      await page.locator("a").filter({ hasText: "Acceso a ruedas" }).click();
      await page.getByRole("columnheader", { name: "Código de rueda" }).waitFor({ state: "visible", timeout: 15_000 });
    }
    await page.locator("td.mat-cell, td[role='cell'], .mat-column-code td")
      .first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  let retryCount = 0;
  while (retryCount < ROUNDTABLE_MAX_RETRIES) {
    log(`Intento ${retryCount + 1}/${ROUNDTABLE_MAX_RETRIES} — apertura rueda ${roundtableCode}`);
    await navigateToRoundtableTable();

    const roundtableCell = page.locator("td.mat-column-code").filter({ hasText: roundtableCode }).first();
    if (await roundtableCell.count() === 0) {
      retryCount++;
      if (retryCount < ROUNDTABLE_MAX_RETRIES) {
        log(`Rueda ${roundtableCode} no encontrada — esperando ${ROUNDTABLE_RETRY_INTERVAL_MS / 1000}s...`);
        const chunks = Math.ceil(ROUNDTABLE_RETRY_INTERVAL_MS / 5_000);
        for (let c = 0; c < chunks; c++) await page.waitForTimeout(5_000);
      }
      continue;
    }

    await roundtableCell.scrollIntoViewIfNeeded();
    const row = roundtableCell.locator("xpath=ancestor::tr").first();
    const habilitado = row.locator("text=Habilitado").first();
    if (await habilitado.count() > 0 && await habilitado.isVisible().catch(() => false)) {
      await habilitado.click().catch(() => habilitado.click({ force: true }));
      await page.waitForTimeout(3_000);
    }

    const waitMsg = page.locator("text=/Por favor espere/i").first();
    if (await waitMsg.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Aceptar" }).click().catch(() => {});
      retryCount++;
      if (retryCount < ROUNDTABLE_MAX_RETRIES) {
        log(`Rueda ${roundtableCode} en espera — reintentando en ${ROUNDTABLE_RETRY_INTERVAL_MS / 1000}s...`);
        const chunks = Math.ceil(ROUNDTABLE_RETRY_INTERVAL_MS / 5_000);
        for (let c = 0; c < chunks; c++) await page.waitForTimeout(5_000);
      }
      continue;
    }

    const tradingVisible =
      await page.getByRole("button", { name: "Comprar" }).first().isVisible().catch(() => false) ||
      await page.getByRole("button", { name: "Vender" }).first().isVisible().catch(() => false) ||
      await page.getByText("Ronda 1", { exact: false }).first().isVisible().catch(() => false) ||
      await page.locator(".col.text-center").filter({ has: page.locator("small") }).first().isVisible().catch(() => false);

    if (tradingVisible) {
      log(`Rueda ${roundtableCode} abierta exitosamente.`);
      return;
    }

    retryCount++;
    if (retryCount < ROUNDTABLE_MAX_RETRIES) {
      log(`Rueda ${roundtableCode}: vista de trading no detectada — reintentando en ${ROUNDTABLE_RETRY_INTERVAL_MS / 1000}s...`);
      const chunks = Math.ceil(ROUNDTABLE_RETRY_INTERVAL_MS / 5_000);
      for (let c = 0; c < chunks; c++) await page.waitForTimeout(5_000);
    }
  }
  throw new Error(`No se pudo abrir la rueda ${roundtableCode} tras ${ROUNDTABLE_MAX_RETRIES} intentos.`);
}

/** Reload page and dismiss any blocking dialogs. */
async function reloadAndSettle(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_500);
  await dismissBlockingDialogs(page);
  await page.waitForTimeout(500);
}

// ── Schedule parsing ─────────────────────────────────────────────────────────

interface PhaseSchedule { name: string; startTime: Date; }

function parseTimeToDate(timeStr: string): Date | null {
  const match = timeStr.trim().match(/(\d{1,2}):(\d{2}):(\d{2})(?:\s*([AP]M))?/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const s = parseInt(match[3]);
  const ampm = (match[4] ?? "").toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d;
}

let _scheduleRawLogged = false;
async function parseAuctionSchedule(page: Page): Promise<PhaseSchedule[]> {
  const cols = page.locator(".col.text-center").filter({ has: page.locator("small") });
  const count = await cols.count().catch(() => 0);
  if (count === 0) return [];

  const phases: PhaseSchedule[] = [];
  for (let i = 0; i < count; i++) {
    const col = cols.nth(i);
    const timeText = await col.locator("small").first().innerText().catch(() => "");
    const nameText = await col.locator("p").first().innerText().catch(() => "");
    const startTime = parseTimeToDate(timeText.trim());
    if (startTime && nameText.trim()) phases.push({ name: nameText.trim(), startTime });
  }

  if (!_scheduleRawLogged && phases.length > 0) {
    log(`[DIAG] Fases detectadas: ${phases.map((p) => `${p.name}@${p.startTime.toLocaleTimeString("es-CO")}`).join(" | ")}`);
    _scheduleRawLogged = true;
  }
  return phases;
}

async function getCurrentAuctionTime(_page: Page): Promise<Date> {
  return new Date();
}

/**
 * Encuentra el índice en el schedule de la Ronda N.
 * Soporta fases numeradas ("Ronda 1") y sin número ("Ronda" repetida — caso MME).
 */
function findRoundPhaseIndex(schedule: PhaseSchedule[], roundNumber: number): number {
  // Intento 1: fase con nombre exacto "Ronda N"
  const namedIdx = schedule.findIndex((p) =>
    p.name.toLowerCase().startsWith(`ronda ${roundNumber}`)
  );
  if (namedIdx !== -1) return namedIdx;

  // Intento 2: N-ésima ocurrencia de fases llamadas sólo "Ronda" (sin dígito a continuación)
  const roundOnlyRe = /^ronda(?!\s*\d)/i;
  let count = 0;
  for (let i = 0; i < schedule.length; i++) {
    if (roundOnlyRe.test(schedule[i].name.trim())) {
      count++;
      if (count === roundNumber) return i;
    }
  }
  return -1;
}

async function isRoundActiveBySchedule(page: Page, roundNumber: number): Promise<boolean> {
  const schedule = await parseAuctionSchedule(page);
  const idx = findRoundPhaseIndex(schedule, roundNumber);
  if (idx === -1) return false;
  const roundStart = schedule[idx].startTime;
  const nextStart  = idx + 1 < schedule.length ? schedule[idx + 1].startTime : null;
  const now = (await getCurrentAuctionTime(page)).getTime();
  return now >= roundStart.getTime() && (!nextStart || now < nextStart.getTime());
}

async function waitForRoundBySchedule(page: Page, roundNumber: number, role: "buyer" | "seller" = "buyer"): Promise<void> {
  const roundName = `Ronda ${roundNumber}`;
  const maxWaitMs = 1_500_000;
  const pollMs    = 15_000;
  const started   = Date.now();
  log(`Esperando ${roundName} según horario...`);

  while (Date.now() - started < maxWaitMs) {
    const schedule = await parseAuctionSchedule(page);
    if (schedule.length > 0) {
      if (await isRoundActiveBySchedule(page, roundNumber)) {
        log(`${roundName} activa según horario — iniciando operaciones.`);
        await page.waitForTimeout(1_000);
        return;
      }
    } else {
      // Schedule no legible — fallback DOM
      if (roundNumber >= 2) {
        const icons = await page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon")
          .filter({ hasText: "edit" }).count().catch(() => 0);
        if (icons > 0) { log(`${roundName}: íconos de edición (schedule no legible).`); return; }
      }
      if (roundNumber === 1) {
        const btnName = role === "buyer" ? "Comprar" : "Vender";
        const visible = await page.getByRole("button", { name: btnName }).first().isVisible().catch(() => false);
        if (visible) { log(`${roundName}: botón "${btnName}" visible (schedule no legible).`); return; }
      }
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    const scheduleStr = schedule.map((p) => `${p.name}@${p.startTime.toLocaleTimeString("es-CO")}`).join(" | ");
    log(`Espera ${roundName}... ${elapsed}s | Fases: ${scheduleStr || "no detectadas"}`);
    await page.waitForTimeout(pollMs);
    await reloadAndSettle(page);
  }
  throw new Error(`Timeout esperando ${roundName} tras ${maxWaitMs / 60_000} min.`);
}

async function confirmRoundEndedBySchedule(page: Page, roundNumber: number): Promise<boolean> {
  const schedule = await parseAuctionSchedule(page);
  if (schedule.length === 0) return false;
  const idx = findRoundPhaseIndex(schedule, roundNumber);
  if (idx === -1) return false;
  for (let i = 0; i < 3; i++) {
    if (await isRoundActiveBySchedule(page, roundNumber)) return false;
    if (i < 2) await page.waitForTimeout(5_000);
  }
  log(`Ronda ${roundNumber} confirmada como terminada según horario.`);
  return true;
}

// ── Seller: get available (non-disabled) projects from dropdown ───────────────

async function getAvailableProject(page: Page): Promise<string | null> {
  // Native <select id="projectId"> — usado en MME
  const nativeSelect = page.locator("select#projectId");
  const isNative = await nativeSelect.isVisible().catch(() => false);

  if (isNative) {
    // Iterar opciones: saltar placeholder (value="") y las deshabilitadas
    const options = await nativeSelect.locator("option").all();
    for (const opt of options) {
      const val  = await opt.getAttribute("value").catch(() => null);
      const dis  = await opt.getAttribute("disabled").catch(() => null);
      if (!val || val === "") continue;   // placeholder
      if (dis !== null) continue;         // ya usada / deshabilitada
      // Seleccionar la opción
      await nativeSelect.selectOption({ value: val });
      await page.waitForTimeout(300);
      const text = await opt.innerText().catch(() => val);
      return text.trim() || val;
    }
    return null;
  }

  // Mat-select: open and pick first non-disabled option
  const matSelect = page.locator("app-modal-posture-for-sale mat-select").first();
  if (await matSelect.isVisible().catch(() => false)) {
    await matSelect.click();
    await page.waitForTimeout(500);
    const opts = page.locator("mat-option:not(.mat-option-disabled)");
    const count = await opts.count();
    if (count > 0) {
      const text = await opts.first().innerText().catch(() => null);
      await opts.first().click();
      await page.waitForTimeout(300);
      return text?.trim() ?? null;
    }
    // Close panel if no options
    await page.keyboard.press("Escape");
  }
  return null;
}

// ── Ronda 1: submit new bids (buyer) ─────────────────────────────────────────

async function submitBuyerBid(page: Page, price: number): Promise<void> {
  const actionButton = page.getByRole("button", { name: "Comprar" }).first();
  await expect(actionButton).toBeVisible({ timeout: 30_000 });
  await actionButton.click();
  await page.waitForTimeout(1_000);

  const dialog = page.locator("mat-dialog-container").first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  await dialog.getByRole("textbox", { name: "Precio ($/kWh)" }).fill(price.toString());
  await page.waitForTimeout(200);
  await dialog.getByRole("textbox", { name: "Cantidad (MW)" }).fill(BID_QTY.toString());
  await page.waitForTimeout(200);

  // Mercado destino (opcional)
  const mercadoSelect = dialog.locator("#destinyMarketId");
  if (await mercadoSelect.isVisible().catch(() => false)) {
    const opts = await mercadoSelect.locator("option:not([disabled]):not([value=''])").all();
    if (opts.length > 0) {
      const val = await opts[0].getAttribute("value").catch(() => null);
      if (val) { await mercadoSelect.selectOption(val); await page.waitForTimeout(200); }
    }
  }

  const ofertarBtn = page.locator("mat-dialog-container").getByRole("button", { name: "Ofertar" });
  await ofertarBtn.waitFor({ state: "visible", timeout: 8_000 });
  await ofertarBtn.click({ force: true });
  await page.waitForTimeout(1_000);

  const aceptarBtn = page.locator("button.btn-primary").filter({ hasText: "Aceptar" });
  if (await aceptarBtn.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
    await aceptarBtn.click();
  } else {
    await closeAcceptDialogIfVisible(page);
  }
  await page.waitForTimeout(500);
  log(`[buyer] Postura enviada: precio=${price}, cantidad=${BID_QTY}`);
}

// ── Ronda 1: submit new bids (seller) ────────────────────────────────────────

async function submitSellerBid(page: Page, price: number): Promise<void> {
  const actionButton = page.getByRole("button", { name: "Vender" }).first();
  await expect(actionButton).toBeVisible({ timeout: 30_000 });
  await actionButton.click();
  await page.waitForTimeout(1_000);

  const dialog = page.locator("app-modal-posture-for-sale, mat-dialog-container").first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  await dialog.getByRole("textbox", { name: "Precio ($/kWh)" }).fill(price.toString());
  await page.waitForTimeout(200);
  await dialog.getByRole("textbox", { name: "Cantidad (MW)" }).fill(BID_QTY.toString());
  await page.waitForTimeout(200);

  // Cantidad mínima (MW) — campo adicional MME
  const cantMinField = dialog.getByRole("textbox", { name: /Cantidad m[íi]nima/i });
  if (await cantMinField.isVisible().catch(() => false)) {
    await cantMinField.fill(BID_QTY_MIN.toString());
    await page.waitForTimeout(200);
  }

  // Proyecto* — seleccionar primer proyecto disponible (no deshabilitado)
  const projectValue = await getAvailableProject(page);
  if (projectValue) {
    log(`[seller] Proyecto seleccionado: ${projectValue}`);
  } else {
    log(`[seller] ADVERTENCIA: No hay proyectos disponibles para esta postura.`);
    // Cerrar el dialog y salir
    const closeBtn = dialog.locator("button").filter({ hasText: /X|close|cerrar/i }).first();
    if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
    return;
  }

  // % FNCER
  const fncerField = dialog.getByRole("textbox", { name: /% FNCER/i });
  if (await fncerField.isVisible().catch(() => false)) {
    await fncerField.fill(BID_FNCER.toString());
    await page.waitForTimeout(200);
  }

  const ofertarBtn = page.locator("app-modal-posture-for-sale").getByRole("button", { name: "Ofertar" });
  await ofertarBtn.waitFor({ state: "visible", timeout: 8_000 });
  await ofertarBtn.click({ force: true });
  await page.waitForTimeout(1_500);

  // Detectar errores de validación del formulario
  const errorMsg = page.locator("mat-error, .alert-danger, snack-bar-container, .mat-snack-bar-container").first();
  const hasError = await errorMsg.isVisible().catch(() => false);
  if (hasError) {
    const errText = await errorMsg.innerText().catch(() => "desconocido");
    log(`[seller] ERROR formulario: ${errText.trim()}`);
    const closeBtn = page.locator("app-modal-posture-for-sale button[aria-label='Close'], app-modal-posture-for-sale .btn-close").first();
    if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
    return;
  }

  const aceptarBtn = page.locator("button.btn-primary").filter({ hasText: "Aceptar" });
  if (await aceptarBtn.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
    await aceptarBtn.click();
  } else {
    await closeAcceptDialogIfVisible(page);
  }
  await page.waitForTimeout(500);
  log(`[seller] Postura enviada: precio=${price}, cantidad=${BID_QTY}`);
}

// ── Round 1 ───────────────────────────────────────────────────────────────────

async function runRound1(
  page: Page,
  role: "buyer" | "seller",
  params: RoundUserParams,
  durationMin: number
): Promise<void> {
  if (params.iterations === 0) { log("Ronda 1: iteraciones=0, se omite."); return; }

  await waitForRoundBySchedule(page, 1, role);

  const intervalMs = params.iterations > 1 ? Math.floor((durationMin * 60_000) / params.iterations) : 0;
  log(`Ronda 1 — ${params.iterations} posturas en ${durationMin}min (intervalo ${intervalMs / 1000}s)`);

  for (let i = 0; i < params.iterations; i++) {
    if (i > 0 && intervalMs > 0) {
      log(`Esperando ${intervalMs / 1000}s antes de postura ${i + 1}/${params.iterations}...`);
      await page.waitForTimeout(intervalMs);
    }
    if (await confirmRoundEndedBySchedule(page, 1)) {
      log(`Ronda 1 finalizada anticipadamente en postura ${i + 1}/${params.iterations}.`);
      break;
    }
    const price = Math.floor(Math.random() * (params.max - params.min + 1)) + params.min;
    log(`Ronda 1 — postura ${i + 1}/${params.iterations}: precio=${price}`);
    if (role === "buyer") {
      await submitBuyerBid(page, price);
    } else {
      await submitSellerBid(page, price);
    }
    await reloadAndSettle(page);
  }
}

// ── Round 2+: update existing bids ───────────────────────────────────────────

async function runRound2Plus(
  page: Page,
  role: "buyer" | "seller",
  roundNumber: number,
  params: RoundUserParams,
  durationMin: number
): Promise<void> {
  if (params.iterations === 0) { log(`Ronda ${roundNumber}: iteraciones=0, se omite.`); return; }

  await waitForRoundBySchedule(page, roundNumber, role);

  // Recargar la página para que el DOM refleje el estado actual de la ronda
  await reloadAndSettle(page);

  // Esperar hasta 30s a que aparezcan los lápices de edición (posturas rechazadas)
  let iconCount = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const icons = page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon").filter({ hasText: "edit" });
    iconCount = await icons.count();
    if (iconCount > 0) break;
    log(`Ronda ${roundNumber}: esperando lápices de edición... intento ${attempt + 1}/6`);
    await page.waitForTimeout(5_000);
    await reloadAndSettle(page);
  }
  if (iconCount === 0) {
    // Todas las posturas fueron aceptadas — no hay nada que modificar.
    // Esperar aquí hasta que la ronda termine según horario antes de continuar.
    log(`Ronda ${roundNumber}: todas las posturas aceptadas (sin lápices). Esperando fin de ronda...`);
    const roundEndMs = durationMin * 60_000;
    const waitStart = Date.now();
    while (Date.now() - waitStart < roundEndMs) {
      if (await confirmRoundEndedBySchedule(page, roundNumber)) break;
      await page.waitForTimeout(10_000);
      await reloadAndSettle(page);
    }
    log(`Ronda ${roundNumber}: fin de espera — pasando a la siguiente fase.`);
    return;
  }

  const intervalMs = params.iterations > 1 ? Math.floor((durationMin * 60_000) / params.iterations) : 0;
  log(`Ronda ${roundNumber} — ${params.iterations} actualizaciones en ${durationMin}min (intervalo ${intervalMs / 1000}s)`);

  for (let i = 0; i < params.iterations; i++) {
    if (i > 0 && intervalMs > 0) {
      log(`Esperando ${intervalMs / 1000}s antes de actualización ${i + 1}/${params.iterations}...`);
      await page.waitForTimeout(intervalMs);
    }
    if (await confirmRoundEndedBySchedule(page, roundNumber)) {
      log(`Ronda ${roundNumber} finalizada anticipadamente en actualización ${i + 1}/${params.iterations}.`);
      break;
    }

    const iconIndex = i % iconCount;
    const iconsNow = page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon").filter({ hasText: "edit" });
    await iconsNow.nth(iconIndex).click();
    await page.waitForTimeout(500);

    const dialog = page.locator("mat-dialog-container").first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    const formScope = role === "seller"
      ? page.locator("app-modal-posture-for-sale")
      : page.locator("app-modal-posture-for-purchase, mat-dialog-container").first();

    const priceField = formScope.getByRole("textbox", { name: "Precio ($/kWh)" });
    const currentPriceRaw = await priceField.inputValue().catch(() => "0");
    const currentPrice = parseFloat(currentPriceRaw.replace(/[^0-9.]/g, "")) || 0;

    let newPrice: number;
    if (role === "seller") {
      const lo = Math.min(params.min, currentPrice);
      const hi = Math.max(params.min, currentPrice);
      newPrice = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    } else {
      const lo = Math.min(currentPrice, params.max);
      const hi = Math.max(currentPrice, params.max);
      newPrice = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }

    await priceField.fill(newPrice.toString());
    await page.waitForTimeout(200);

    // Buyer: actualizar cantidad y mercado si están visibles
    if (role === "buyer") {
      const qtyField = formScope.getByRole("textbox", { name: "Cantidad (MW)" });
      if (await qtyField.isVisible().catch(() => false)) {
        await qtyField.fill(BID_QTY.toString());
        await page.waitForTimeout(200);
      }
    }

    log(`Ronda ${roundNumber} — actualización ${i + 1}/${params.iterations} (fila ${iconIndex + 1}): ${currentPrice} → ${newPrice}`);

    const ofertarBtn = role === "seller"
      ? page.locator("app-modal-posture-for-sale").getByRole("button", { name: "Ofertar" })
      : page.locator("mat-dialog-container").getByRole("button", { name: "Ofertar" });
    await ofertarBtn.waitFor({ state: "visible", timeout: 8_000 });
    await ofertarBtn.click({ force: true });
    await page.waitForTimeout(1_000);

    const aceptarBtn = page.getByRole("button", { name: "Aceptar" });
    if (await aceptarBtn.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
      await aceptarBtn.click();
    } else {
      await closeAcceptDialogIfVisible(page);
    }
    await page.waitForTimeout(700);
    await reloadAndSettle(page);
  }

  log(`Ronda ${roundNumber} completada para ${role}.`);
}

// ── Full auction orchestrator ─────────────────────────────────────────────────

async function runFullAuction(page: Page, role: "buyer" | "seller", user: MmeUser): Promise<void> {
  const rounds = await readRounds();
  log(`\n=== Iniciando subasta MME para ${role} (${user.username}) — ${rounds.length} rondas ===\n`);

  for (let idx = 0; idx < rounds.length; idx++) {
    const roundCfg: RoundConfig = rounds[idx];
    const roundNumber  = Number(roundCfg.round);
    const durationMin  = Number(roundCfg.duration_min);
    const waitAfterMin = Number(roundCfg.wait_after_min);
    const params       = getRoundParams(user, roundNumber);
    const isLast       = idx === rounds.length - 1;

    log(`\n── Ronda ${roundNumber} ── duración: ${durationMin}min | espera post: ${waitAfterMin}min`);
    log(`   Params ${role}: iterations=${params.iterations}, min=${params.min}, max=${params.max}`);

    if (roundNumber === 1) {
      await runRound1(page, role, params, durationMin);
    } else {
      await runRound2Plus(page, role, roundNumber, params, durationMin);
    }

    if (!isLast) {
      const nextRound = roundNumber + 1;
      log(`\nRonda ${roundNumber} completada. Sondeando Ronda ${nextRound} cada 5s (máx ${waitAfterMin}min)...`);
      const maxWaitMs = Math.max(waitAfterMin * 60_000, 30_000);
      const waitStart = Date.now();
      let nextRoundReady = false;

      while (Date.now() - waitStart < maxWaitMs) {
        await reloadAndSettle(page);
        if (await isRoundActiveBySchedule(page, nextRound)) {
          log(`Ronda ${nextRound} activa según horario — saltando espera.`);
          nextRoundReady = true;
          break;
        }
        const elapsed = Math.round((Date.now() - waitStart) / 1000);
        const schedule = await parseAuctionSchedule(page);
        const str = schedule.map((p) => `${p.name}@${p.startTime.toLocaleTimeString("es-CO")}`).join(" | ");
        log(`  Intermedio/Publicación ${elapsed}s | Fases: ${str || "no detectadas"}`);
        await page.waitForTimeout(5_000);
      }

      if (!nextRoundReady) log(`Iniciando sondeo formal de Ronda ${nextRound}...`);
    }
  }

  log(`\n=== Subasta MME finalizada para ${role} (${user.username}) ===\n`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("Subasta MME (todas las rondas)", () => {
  // Un test por cada fila activa en mme-users.csv
  for (const user of ALL_USERS) {
    const label = `${user.role} - ${user.username}`;
    test(label, async ({ page }) => {
      test.setTimeout(7_200_000);
      await login(page, user.username, user.password);
      await openRoundtable(page, RT_CONFIG.roundtable_code);
      await runFullAuction(page, user.role, user);
    });
  }
});
