CREATE TABLE "evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"sha" text NOT NULL,
	"exit_code" integer NOT NULL,
	"timed_out" boolean NOT NULL,
	"passed" boolean NOT NULL,
	"output" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "pull_request_url" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;