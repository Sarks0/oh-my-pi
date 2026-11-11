/**
 * Postgres client + migration. Uses Bun's built-in SQL driver (Bun.SQL) against a
 * DATABASE_URL, so production points at a real Postgres (ARTEX-style sidecar) and
 * tests point at a local one — same wire protocol. The DB is OPTIONAL: when
 * DATABASE_URL is unset the console runs on FS reads alone (no ledger/projection).
 */
import schemaSql from "./schema.sql" with { type: "text" };

// Bun.SQL is a runtime global; typed loosely to avoid a hard type dependency.
export type Db = {
	unsafe(q: string): Promise<unknown>;
	end(): Promise<void>;
	(strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]>;
	(obj: Record<string, unknown>): unknown;
};

export function makeDb(url: string): Db {
	return new (Bun as unknown as { SQL: new (u: string) => Db }).SQL(url);
}

/** Apply the schema (idempotent). Safe to run on every startup. */
export async function migrate(sql: Db): Promise<void> {
	await sql.unsafe(schemaSql);
}
