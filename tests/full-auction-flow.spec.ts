/**
 * full-auction-flow.spec.ts
 *
 * Orquesta una subasta completa (2–5 rondas) para buyer y seller en paralelo.
 * Configuración:
 *   data/rounds.csv           → tiempos globales por ronda (igual para todos)
 *   data/full-auction-users.csv → credenciales + parámetros por ronda por usuario
 */

import { test, expect, type Page } from "@playwright/test";
import { readRounds } from "../src/csvRounds";
import type { RoundConfig, FullAuctionUser, RoundtableConfig } from "../src/types";
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

function loadUsersCsvSync(): FullAuctionUser[] {
  return parseCsvSync<FullAuctionUser>(
    path.resolve(__dirname, "../data/full-auction-users.csv")
  ).filter((u) => u.active === "true");
}

function loadRoundtableConfig(): RoundtableConfig {
  const rows = parseCsvSync<RoundtableConfig>(
    path.resolve(__dirname, "../data/roundtable-config.csv")
  );
  if (rows.length === 0) throw new Error("roundtable-config.csv está vacío");
  return rows[0];
}

const ALL_USERS  = loadUsersCsvSync();
const RT_CONFIG  = loadRoundtableConfig();

// ── Constants ────────────────────────────────────────────────────────────────

const LOGIN_SETTLE_MS = Number(process.env.LOGIN_SETTLE_MS ?? "1200");
const ROUNDTABLE_RETRY_INTERVAL_MS = Number(process.env.ROUNDTABLE_RETRY_INTERVAL_MS ?? "60000");
const ROUNDTABLE_MAX_RETRIES = Number(process.env.ROUNDTABLE_MAX_RETRIES ?? "5");
const BID_QTY = Number(process.env.BID_QTY ?? "1");
const BID_FNCER = Number(process.env.BID_FNCER ?? "5");
const BUYER_MERCADO_DESTINO = process.env.BUYER_MERCADO_DESTINO ?? "214";

// ── Logger ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toLocaleString("es-CO", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  console.log(`[${ts}] ${msg}`);
}

// ── Helpers: round params from user row ─────────────────────────────────────

interface RoundUserParams {
  iterations: number;
  min: number;
  max: number;
}

function getRoundParams(user: FullAuctionUser, roundNumber: number): RoundUserParams {
  const key = `r${roundNumber}` as `r${1 | 2 | 3 | 4 | 5}`;
  return {
    iterations: Number(user[`${key}_iterations`] ?? 0),
    min: Number(user[`${key}_min`] ?? 0),
    max: Number(user[`${key}_max`] ?? 0),
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

async function dismissBlockingDialogs(page: Page): Promise<boolean> {
  const dialog = page.getByRole("dialog");
  let sessionRevoked = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const yesBtn    = dialog.getByRole("button", { name: "Sí" });
    const acceptBtn = dialog.getByRole("button", { name: "Aceptar" });
    const okBtn     = dialog.getByRole("button", { name: "OK" });
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
  await page.waitForTimeout(2_000);
  if (sessionRevoked || page.url().includes("/auth/sign-in")) {
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

// ── Navigation ───────────────────────────────────────────────────────────────

async function closeAcceptDialogIfVisible(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) return;
  const acceptBtn = dialog.getByRole("button", { name: "Aceptar" });
  const okBtn     = dialog.getByRole("button", { name: "OK" });
  if (await acceptBtn.isVisible().catch(() => false))      await acceptBtn.click();
  else if (await okBtn.isVisible().catch(() => false))     await okBtn.click();
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
    const elementCount = await roundtableCell.count();
    log(`Elementos encontrados con código ${roundtableCode}: ${elementCount}`);

    if (elementCount === 0) {
      retryCount += 1;
      if (retryCount < ROUNDTABLE_MAX_RETRIES) await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
      continue;
    }

    await roundtableCell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const row = roundtableCell.locator("xpath=ancestor::tr").first();
    const habilitadoInRow = row.locator("text=Habilitado").first();

    if (await habilitadoInRow.count() > 0 && await habilitadoInRow.isVisible().catch(() => false)) {
      log(`Clickeando Habilitado para rueda ${roundtableCode}`);
      await habilitadoInRow.click().catch(() => habilitadoInRow.click({ force: true }));
      await page.waitForTimeout(3_000);
    }

    const waitMsg = page.locator("text=/Por favor espere/i").first();
    if (await waitMsg.isVisible().catch(() => false)) {
      log("Rueda aún no iniciada, esperando...");
      await page.getByRole("button", { name: "Aceptar" }).click().catch(() => {});
      retryCount += 1;
      if (retryCount < ROUNDTABLE_MAX_RETRIES) await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
      continue;
    }

    const tradingVisible =
      await page.getByRole("button", { name: "Comprar" }).first().isVisible().catch(() => false) ||
      await page.getByRole("button", { name: "Vender" }).first().isVisible().catch(() => false) ||
      await page.getByText("Ronda 1", { exact: false }).first().isVisible().catch(() => false);

    if (tradingVisible) {
      log(`Rueda ${roundtableCode} abierta exitosamente.`);
      return;
    }

    retryCount += 1;
    if (retryCount < ROUNDTABLE_MAX_RETRIES) await page.waitForTimeout(ROUNDTABLE_RETRY_INTERVAL_MS);
  }

  throw new Error(`No se pudo abrir la rueda ${roundtableCode} tras ${ROUNDTABLE_MAX_RETRIES} intentos.`);
}

// ── Schedule-based round detection ──────────────────────────────────────────

interface PhaseSchedule {
  name: string;       // "Ronda 1", "Intermedio 1", "Publicación 1", etc.
  startTime: Date;    // today's date + parsed time from progress bar
}

/** Parse "11:23:00 AM" or "11:23:00" into a Date using today's date */
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

/**
 * Reads the auction phase schedule from the timeline columns.
 * Structure: each phase is a .col.text-center div with:
 *   <small> = start time (e.g. " 11:58:00 AM ")
 *   <p>     = phase name (e.g. " Ronda 1 ")
 */
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
    if (startTime && nameText.trim()) {
      phases.push({ name: nameText.trim(), startTime });
    }
  }

  if (!_scheduleRawLogged && phases.length > 0) {
    const summary = phases.map((p) => `${p.name}@${p.startTime.toLocaleTimeString("es-CO")}`).join(" | ");
    log(`[DIAG] Fases detectadas: ${summary}`);
    _scheduleRawLogged = true;
  }

  return phases;
}

/**
 * Returns current time as a Date.
 * The auction timer is rendered inside an external iframe (timeanddate.com)
 * which cannot be read by Playwright — we use the system clock instead.
 */
let _timerSelectorLogged = false;
async function getCurrentAuctionTime(_page: Page): Promise<Date | null> {
  if (!_timerSelectorLogged) {
    log(`[DIAG] Hora actual (reloj sistema): ${new Date().toLocaleTimeString("es-CO")}`);
    _timerSelectorLogged = true;
  }
  return new Date();
}

/**
 * Returns true if the current auction time is within the given round's window.
 * A round ends when the next phase starts.
 */
async function isRoundActiveBySchedule(page: Page, roundNumber: number): Promise<boolean> {
  const schedule = await parseAuctionSchedule(page);
  const roundName = `Ronda ${roundNumber}`;
  const idx = schedule.findIndex((p) => p.name.toLowerCase().startsWith(roundName.toLowerCase()));
  if (idx === -1) return false;

  const roundStart = schedule[idx].startTime;
  const nextStart  = idx + 1 < schedule.length ? schedule[idx + 1].startTime : null;
  const now = await getCurrentAuctionTime(page);
  if (!now) return false;

  const t = now.getTime();
  return t >= roundStart.getTime() && (!nextStart || t < nextStart.getTime());
}

/**
 * Polls every 15 s until the given round is active according to the schedule.
 * Falls back to icon/button detection if schedule can't be parsed.
 */
async function waitForRoundBySchedule(page: Page, roundNumber: number, role: "buyer" | "seller" = "buyer"): Promise<void> {
  const roundName = `Ronda ${roundNumber}`;
  const maxWaitMs = 1_500_000;
  const pollMs    = 15_000;
  const started   = Date.now();

  log(`Esperando ${roundName} según horario de la barra de fases (sondeo cada ${pollMs / 1000}s)...`);

  while (Date.now() - started < maxWaitMs) {
    const schedule = await parseAuctionSchedule(page);

    if (schedule.length > 0) {
      // Schedule readable — use ONLY schedule-based timing, no DOM fallbacks
      if (await isRoundActiveBySchedule(page, roundNumber)) {
        log(`${roundName} activa según horario — iniciando operaciones.`);
        await page.waitForTimeout(1_000);
        return;
      }
    } else {
      // Schedule unreadable — fall back to DOM signals only in this case
      if (roundNumber >= 2) {
        const iconsCount = await page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon")
          .filter({ hasText: "edit" }).count().catch(() => 0);
        if (iconsCount > 0) {
          log(`${roundName}: íconos de edición presentes (schedule no legible) — iniciando operaciones.`);
          await page.waitForTimeout(500);
          return;
        }
      }
      if (roundNumber === 1) {
        const btnName = role === "buyer" ? "Comprar" : "Vender";
        const btnVisible = await page.getByRole("button", { name: btnName }).first().isVisible().catch(() => false);
        if (btnVisible) {
          log(`${roundName}: botón "${btnName}" visible (schedule no legible) — iniciando operaciones.`);
          await page.waitForTimeout(500);
          return;
        }
      }
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    const scheduleStr = schedule.map((p) => `${p.name}@${p.startTime.toLocaleTimeString("es-CO")}`).join(" | ");
    const nowTime = await getCurrentAuctionTime(page);
    log(`Espera ${roundName}... ${elapsed}s | Hora actual: ${nowTime?.toLocaleTimeString("es-CO") ?? "?"} | Fases: ${scheduleStr || "no detectadas"}`);
    await page.waitForTimeout(pollMs);
    await reloadAndSettle(page);
  }

  throw new Error(`Timeout esperando ${roundName} tras ${maxWaitMs / 60_000} min.`);
}

/**
 * Confirms a round ended by checking the schedule 3 times with 5 s gaps.
 * Returns true only if schedule is readable AND all checks agree the round is no longer active.
 * IMPORTANT: if schedule is unreadable, returns false (cannot confirm = stay in round).
 */
async function confirmRoundEndedBySchedule(page: Page, roundNumber: number): Promise<boolean> {
  const schedule = await parseAuctionSchedule(page);

  // Can't read schedule → cannot confirm ended
  if (schedule.length === 0) {
    log(`[DIAG] confirmRoundEndedBySchedule(${roundNumber}): schedule vacío — asumiendo ronda sigue activa.`);
    return false;
  }

  // Round not found in schedule (e.g. Ronda 2 doesn't appear until later) → cannot confirm ended
  const roundName = `Ronda ${roundNumber}`;
  const idx = schedule.findIndex((p) => p.name.toLowerCase().startsWith(roundName.toLowerCase()));
  if (idx === -1) {
    log(`[DIAG] confirmRoundEndedBySchedule(${roundNumber}): "${roundName}" no está en el schedule — asumiendo ronda sigue activa.`);
    return false;
  }

  // Round IS in schedule — check 3× if it's still within its time window
  for (let i = 0; i < 3; i++) {
    if (await isRoundActiveBySchedule(page, roundNumber)) return false; // still active
    if (i < 2) await page.waitForTimeout(5_000);
  }
  log(`Ronda ${roundNumber} confirmada como terminada según horario.`);
  return true;
}

async function areEditIconsAvailable(page: Page): Promise<boolean> {
  const count = await page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon")
    .filter({ hasText: "edit" }).count().catch(() => 0);
  return count > 0;
}

/** Reload page and dismiss any blocking dialogs, then wait for settle. */
async function reloadAndSettle(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_500);
  await dismissBlockingDialogs(page);
  await page.waitForTimeout(500);
}

// ── Round 1: submit new bids ─────────────────────────────────────────────────

async function submitBid(page: Page, role: "buyer" | "seller", price: number): Promise<void> {
  const actionButtonName = role === "buyer" ? "Comprar" : "Vender";
  const actionButton = page.getByRole("button", { name: actionButtonName }).first();
  await expect(actionButton).toBeVisible({ timeout: 30_000 });
  await actionButton.click();
  await page.waitForTimeout(1_000);

  const dialog = page.locator("mat-dialog-container").first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  await dialog.getByRole("textbox", { name: "Precio ($/kWh)" }).fill(price.toString());
  await page.waitForTimeout(200);

  await dialog.getByRole("textbox", { name: "Cantidad (MW)" }).click();
  await dialog.getByRole("textbox", { name: "Cantidad (MW)" }).fill(BID_QTY.toString());
  await page.waitForTimeout(200);

  if (role === "seller") {
    await dialog.getByRole("textbox", { name: "% FNCER" }).fill(BID_FNCER.toString());
    await page.waitForTimeout(200);
  }

  const mercadoSelect = dialog.locator("#destinyMarketId");
  if (await mercadoSelect.isVisible().catch(() => false)) {
    await mercadoSelect.selectOption(BUYER_MERCADO_DESTINO);
    await page.waitForTimeout(200);
    log(`Mercado destino seleccionado: ${BUYER_MERCADO_DESTINO}`);
  }

  const ofertarBtn = role === "seller"
    ? page.locator("app-modal-posture-for-sale").getByRole("button", { name: "Ofertar" })
    : page.locator("mat-dialog-container").getByRole("button", { name: "Ofertar" });
  await ofertarBtn.waitFor({ state: "visible", timeout: 8_000 });
  await ofertarBtn.click({ force: true });
  await page.waitForTimeout(1_000);

  const aceptarBtn = page.locator("button.btn-primary").filter({ hasText: "Aceptar" });
  const aceptarVisible = await aceptarBtn.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (aceptarVisible) await aceptarBtn.click();
  else await closeAcceptDialogIfVisible(page);
  await page.waitForTimeout(500);

  log(`Postura enviada: precio=${price}, cantidad=${BID_QTY}`);
}

async function runRound1(
  page: Page,
  role: "buyer" | "seller",
  params: RoundUserParams,
  durationMin: number
): Promise<void> {
  if (params.iterations === 0) { log("Ronda 1: iteraciones=0, se omite."); return; }

  // Wait until Ronda 1 is actually active (handles Preapertura)
  await waitForRoundBySchedule(page, 1, role);
  // Reload to ensure the trading UI is fully rendered before first bid
  await reloadAndSettle(page);
  log(`Página recargada — listo para posturas Ronda 1.`);

  const intervalMs = params.iterations > 1 ? Math.floor((durationMin * 60_000) / params.iterations) : 0;
  log(`Ronda 1 — ${params.iterations} posturas en ${durationMin}min (intervalo ${intervalMs / 1000}s)`);

  for (let i = 0; i < params.iterations; i++) {
    if (i > 0 && intervalMs > 0) {
      log(`Esperando ${intervalMs / 1000}s antes de postura ${i + 1}/${params.iterations}...`);
      await page.waitForTimeout(intervalMs);
    }
    // Check if round is still active according to schedule (not button visibility)
    if (await confirmRoundEndedBySchedule(page, 1)) {
      log(`Ronda 1 finalizada anticipadamente en postura ${i + 1}/${params.iterations} (horario confirma fin).`);
      break;
    }
    const price = Math.floor(Math.random() * (params.max - params.min + 1)) + params.min;
    log(`Ronda 1 — postura ${i + 1}/${params.iterations}: precio=${price}`);
    await submitBid(page, role, price);
    await reloadAndSettle(page);
  }
}

// ── Round 2+: update existing bids ──────────────────────────────────────────

async function waitForRoundIndicator(page: Page, roundNumber: number): Promise<void> {
  const label = `Ronda ${roundNumber}`;
  const maxWaitMs = 1_500_000;
  const pollMs = 15_000;
  const startTime = Date.now();

  log(`Sondeando cada ${pollMs / 1000}s hasta detectar ${label} o íconos de edición...`);

  while (Date.now() - startTime < maxWaitMs) {
    // Check 1: edit icons visible (pencil buttons for round 2+)
    const iconsAvailable = await areEditIconsAvailable(page);
    if (iconsAvailable) {
      log(`${label}: íconos de edición detectados — iniciando ronda.`);
      await page.waitForTimeout(500);
      return;
    }

    // Check 2: round label visible in progress bar
    const labelVisible = await page.getByText(label, { exact: true }).first().isVisible().catch(() => false);
    if (labelVisible) {
      log(`${label} detectada en barra de seguimiento.`);
      await page.waitForTimeout(500);
      return;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`Esperando ${label}... (${elapsed}s transcurridos, próximo sondeo en ${pollMs / 1000}s)`);
    await page.waitForTimeout(pollMs);
  }

  throw new Error(`Timeout esperando ${label} tras ${maxWaitMs / 60_000} minutos.`);
}

async function updateOneBid(
  page: Page,
  role: "buyer" | "seller",
  iconIndex: number,
  newPrice: number
): Promise<void> {
  const icons = page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon").filter({ hasText: "edit" });
  const iconCount = await icons.count();
  if (iconIndex >= iconCount) {
    log(`Ícono ${iconIndex} no disponible (solo hay ${iconCount}), usando índice ${iconIndex % iconCount}`);
  }
  await icons.nth(iconIndex % Math.max(iconCount, 1)).click();
  await page.waitForTimeout(500);

  const dialog = page.locator("mat-dialog-container").first();
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  const formScope = role === "seller"
    ? page.locator("app-modal-posture-for-sale")
    : page.locator("app-modal-posture-for-purchase, mat-dialog-container").first();

  const priceField = formScope.getByRole("textbox", { name: "Precio ($/kWh)" });
  await priceField.click();
  const currentPriceRaw = await priceField.inputValue().catch(() => "0");
  const currentPrice = parseFloat(currentPriceRaw.replace(/[^0-9.]/g, "")) || 0;
  log(`  precio actual: ${currentPrice} → nuevo: ${newPrice}`);

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
      await mercadoSelect.selectOption(BUYER_MERCADO_DESTINO);
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

async function runRound2Plus(
  page: Page,
  role: "buyer" | "seller",
  roundNumber: number,
  params: RoundUserParams,
  durationMin: number
): Promise<void> {
  if (params.iterations === 0) { log(`Ronda ${roundNumber}: iteraciones=0, se omite.`); return; }

  await waitForRoundBySchedule(page, roundNumber);
  // Reload to ensure edit icons are fully rendered before first update
  await reloadAndSettle(page);
  log(`Página recargada — listo para actualizaciones Ronda ${roundNumber}.`);

  const intervalMs = params.iterations > 1 ? Math.floor((durationMin * 60_000) / params.iterations) : 0;
  log(`Ronda ${roundNumber} — ${params.iterations} actualizaciones en ${durationMin}min (intervalo ${intervalMs / 1000}s)`);

  // Get initial icon count for round-robin indexing
  const icons = page.locator("table tbody tr mat-icon, table tr[role='row'] mat-icon").filter({ hasText: "edit" });
  const iconCount = await icons.count();
  if (iconCount === 0) { log(`Ronda ${roundNumber}: no hay posturas para actualizar.`); return; }

  for (let i = 0; i < params.iterations; i++) {
    if (i > 0 && intervalMs > 0) {
      log(`Esperando ${intervalMs / 1000}s antes de actualización ${i + 1}/${params.iterations}...`);
      await page.waitForTimeout(intervalMs);
    }
    // Check if round is still active according to schedule
    if (await confirmRoundEndedBySchedule(page, roundNumber)) {
      log(`Ronda ${roundNumber} finalizada anticipadamente en actualización ${i + 1}/${params.iterations} (horario confirma fin).`);
      break;
    }

    // Capture current price to compute range
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
    await priceField.click();
    const currentPriceRaw = await priceField.inputValue().catch(() => "0");
    const currentPrice = parseFloat(currentPriceRaw.replace(/[^0-9.]/g, "")) || 0;

    // seller: random between min and currentPrice (goes down)
    // buyer:  random between currentPrice and max  (goes up)
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

    log(`Ronda ${roundNumber} — actualización ${i + 1}/${params.iterations} (fila ${iconIndex + 1}): ${currentPrice} → ${newPrice}`);
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
        await mercadoSelect.selectOption(BUYER_MERCADO_DESTINO);
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
    await reloadAndSettle(page);
  }

  log(`Ronda ${roundNumber} completada para ${role}.`);
}

// ── Full auction orchestrator ────────────────────────────────────────────────

async function runFullAuction(page: Page, role: "buyer" | "seller", user: FullAuctionUser): Promise<void> {
  const rounds = await readRounds();

  // Validate round count (2–5)
  const roundNumbers = rounds.map((r) => Number(r.round));
  if (roundNumbers.length < 2 || roundNumbers.length > 5) {
    throw new Error(`rounds.csv debe tener entre 2 y 5 rondas. Encontradas: ${roundNumbers.length}`);
  }

  log(`\n=== Iniciando subasta completa para ${role} — ${rounds.length} rondas ===\n`);

  for (let idx = 0; idx < rounds.length; idx++) {
    const roundCfg: RoundConfig = rounds[idx];
    const roundNumber = Number(roundCfg.round);
    const durationMin = Number(roundCfg.duration_min);
    const waitAfterMin = Number(roundCfg.wait_after_min);
    const params = getRoundParams(user, roundNumber);
    const isLast = idx === rounds.length - 1;

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
      const pollMs = 5_000;
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
        const scheduleStr = schedule.map((p) => `${p.name}@${p.startTime.toLocaleTimeString("es-CO")}`).join(" | ");
        log(`  Intermedio/Publicación ${elapsed}s | Fases: ${scheduleStr || "no detectadas"}`);
        await page.waitForTimeout(pollMs);
      }

      if (!nextRoundReady) log(`Iniciando sondeo formal de Ronda ${nextRound}...`);
    }
  }

  log(`\n=== Subasta completa finalizada para ${role} ===\n`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("Subasta completa (todas las rondas)", () => {
  // Un test por cada fila activa en full-auction-users.csv
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
