export type UserRole = "buyer" | "seller";

export interface AccessUser {
  role: UserRole;
  company: string;
  profile: string;
  username: string;
  password: string;
  product: string;
  roundtable_code: string;
  iterations: string;
  minutes: string;
  min_amount: string;
  max_amount: string;
  active: string;
}

// ── Full-auction types (full-auction-flow.spec.ts) ──────────────────────────

export interface RoundConfig {
  round: string;           // "1" .. "5"
  duration_min: string;
  wait_after_min: string;
}

// ── MME-auction types (mme-auction-flow.spec.ts) ────────────────────────────

export interface MmeUser {
  role: UserRole;
  username: string;
  password: string;
  active: string;
  r1_iterations: string; r1_min: string; r1_max: string;
  r2_iterations: string; r2_min: string; r2_max: string;
  r3_iterations: string; r3_min: string; r3_max: string;
}

export interface RoundtableConfig {
  auction_type: "MCE" | "MME";
  roundtable_code: string;
  product: string;
}

export interface FullAuctionUser {
  role: UserRole;
  username: string;
  password: string;
  active: string;
  r1_iterations: string; r1_min: string; r1_max: string;
  r2_iterations: string; r2_min: string; r2_max: string;
  r3_iterations: string; r3_min: string; r3_max: string;
  r4_iterations: string; r4_min: string; r4_max: string;
  r5_iterations: string; r5_min: string; r5_max: string;
}

