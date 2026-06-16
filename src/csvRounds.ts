import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { RoundConfig, FullAuctionUser, MmeUser, UserRole } from "./types";

const ROUNDS_FILE = path.resolve(__dirname, "..", "data", "rounds.csv");
const FULL_AUCTION_USERS_FILE = path.resolve(__dirname, "..", "data", "full-auction-users.csv");
const MME_USERS_FILE = path.resolve(__dirname, "..", "data", "mme-users.csv");

export async function readRounds(): Promise<RoundConfig[]> {
  const csvRaw = await fs.readFile(ROUNDS_FILE, "utf-8");
  return parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true }) as RoundConfig[];
}

export async function readFullAuctionUsersByRole(role: UserRole): Promise<FullAuctionUser[]> {
  const csvRaw = await fs.readFile(FULL_AUCTION_USERS_FILE, "utf-8");
  const users = parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true }) as FullAuctionUser[];
  return users.filter((u) => u.role === role && u.active.toLowerCase() === "true");
}

export async function readMmeUsersByRole(role: UserRole): Promise<MmeUser[]> {
  const csvRaw = await fs.readFile(MME_USERS_FILE, "utf-8");
  const users = parse(csvRaw, { columns: true, skip_empty_lines: true, trim: true }) as MmeUser[];
  return users.filter((u) => u.role === role && u.active.toLowerCase() === "true");
}
