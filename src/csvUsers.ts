import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import type { AccessUser, UserRole } from "./types";

const USERS_FILE = path.resolve(__dirname, "..", "data", "users.csv");

export async function readActiveUsersByRole(role: UserRole): Promise<AccessUser[]> {
  const csvRaw = await fs.readFile(USERS_FILE, "utf-8");

  const users = parse(csvRaw, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as AccessUser[];

  return users.filter((user) => user.role === role && user.active.toLowerCase() === "true");
}
