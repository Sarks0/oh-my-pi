import { beforeAll, describe, expect, test } from "bun:test";
import { type Db, makeDb, migrate } from "../db/client";
import { createTask, getTask, graphStoreForTask, listTasks, setTaskStatus } from "./tasks";

const URL = process.env.TEST_DATABASE_URL;
const suite = URL ? describe : describe.skip; // skip cleanly when no test DB is configured

suite("Tasks on Postgres — persistence + the graph store contract", () => {
	let db: Db;
	beforeAll(async () => {
		db = makeDb(URL as string);
		await migrate(db);
		await db.unsafe("TRUNCATE tasks RESTART IDENTITY CASCADE"); // cascades to nodes/edges/activity
	});

	test("createTask seeds the graph (origin fact + goal) and is retrievable", async () => {
		const t = await createTask(db, { goal: "prove the EOP", name: "demo", cwd: "/lab/x", config: { allowMutations: true } });
		expect(t.id).toBeGreaterThan(0);
		expect(t.status).toBe("draft");
		expect(t.config.allowMutations).toBe(true);

		const got = await getTask(db, t.id);
		expect(got?.goal).toBe("prove the EOP");

		const ov = await graphStoreForTask(db, t.id).overview();
		expect(ov.goal).toBe("prove the EOP");
		expect(ov.nodes.some(n => n.kind === "fact" && n.state === "origin")).toBe(true);
		expect(ov.edges.some(e => e.rel === "spawns")).toBe(true);
	});

	test("the PgGraphStore honours the same contract as in-memory, end to end", async () => {
		const t = await createTask(db, { goal: "g2" });
		const store = graphStoreForTask(db, t.id);

		const i1 = await store.addIntent("enumerate IOCTLs");
		await store.addIntent("check the DACL");
		expect((await store.overview()).frontierOpen).toBe(2);

		const claimed = await store.claimIntent();
		expect(claimed?.id).toBe(i1.id);
		expect(claimed?.state).toBe("running");

		const fact = await store.reportFact(claimed!.id, "0x222000 reachable");
		expect(fact).toMatchObject({ kind: "fact", state: "confirmed", intentId: i1.id });

		const ov = await store.overview();
		expect(ov.frontierOpen).toBe(1); // one intent still open
		expect(ov.running).toBe(0); // the claimed one settled to done
		expect(ov.edges.some(e => e.rel === "yields")).toBe(true);

		// a worker proves a finding on the remaining intent
		const claimed2 = await store.claimIntent();
		const finding = await store.reportFinding(claimed2!.id, "confirmed EOP");
		expect(finding.kind).toBe("finding");
		const ov2 = await store.overview();
		expect(ov2.nodes.some(n => n.kind === "finding" && n.state === "confirmed")).toBe(true);
		expect(ov2.edges.some(e => e.rel === "proves")).toBe(true);
	});

	test("claimIntent is atomic: each open intent is claimed at most once", async () => {
		const t = await createTask(db, { goal: "g3" });
		const store = graphStoreForTask(db, t.id);
		await store.addIntent("a");
		await store.addIntent("b");

		// two concurrent claims must return two DISTINCT intents, never the same one
		const [c1, c2] = await Promise.all([store.claimIntent(), store.claimIntent()]);
		expect(c1).not.toBeNull();
		expect(c2).not.toBeNull();
		expect(c1!.id).not.toBe(c2!.id);

		// the frontier is now empty → a third claim returns null
		expect(await store.claimIntent()).toBeNull();
	});

	test("reportFact rejects an intent from another task", async () => {
		const a = await createTask(db, { goal: "a" });
		const b = await createTask(db, { goal: "b" });
		const intentA = await graphStoreForTask(db, a.id).addIntent("x");
		// task b's store must not be able to settle task a's intent
		expect(graphStoreForTask(db, b.id).reportFact(intentA.id, "nope")).rejects.toThrow(/no such intent/);
	});

	test("listTasks returns created tasks newest-first; setTaskStatus logs activity", async () => {
		const before = (await listTasks(db)).length;
		const t = await createTask(db, { goal: "status demo" });
		await setTaskStatus(db, t.id, "running");
		expect((await getTask(db, t.id))?.status).toBe("running");
		expect((await listTasks(db)).length).toBe(before + 1);
		const [act] = await db`SELECT kind, detail FROM task_activity WHERE task_id=${t.id} ORDER BY id DESC LIMIT 1`;
		expect(act).toMatchObject({ kind: "status_change", detail: "running" });
	});
});
