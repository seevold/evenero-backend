// Generer kort, lesbart ordre-nummer for kunde (eks. "EV-2026-0042").
// Format: EV-{year}-{4-digit sequence}. Sekvens er global per år, hentet
// via SQL-aggregat — ikke en separat counter-tabell (enklere, robust nok
// for forventet volum).

import { pool } from "../db";

export async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const result = await pool.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(
       (regexp_match(order_number, '^EV-' || $1::text || '-(\\d{4,})$'))[1]::int
     ), 0) + 1 AS next_seq
     FROM print_orders
     WHERE order_number LIKE 'EV-' || $1::text || '-%'`,
    [year],
  );
  const seq = parseInt(result.rows[0]?.next_seq || "1", 10);
  return `EV-${year}-${String(seq).padStart(4, "0")}`;
}
