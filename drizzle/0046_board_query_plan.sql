-- The board's card query looks for the event just before or after another of any stage of the same task.
CREATE INDEX IF NOT EXISTS "stage_event_task_id_id" ON "stage_event" USING btree ("task_id","id");--> statement-breakpoint
-- The card query is one aggregate with dozens of correlated subqueries, which the planner costs in the millions.
-- JIT then compiled it on every poll: 7.6 of its 8.3 seconds on 2026-11-19, against 0.48 seconds without JIT.
-- The factory's queries are short transactions that JIT never pays back, so the database runs without it.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET jit = off', current_database()); END $$;
