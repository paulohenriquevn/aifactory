CREATE TABLE "question" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"body" text NOT NULL,
	"comment_id" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot_id" text NOT NULL,
	"session_id" text NOT NULL,
	"harness" text NOT NULL,
	"repo_dir" text NOT NULL,
	"base_sha" text NOT NULL,
	"attempt" integer NOT NULL,
	"cost_usd" real NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"resumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "question" ADD CONSTRAINT "question_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;