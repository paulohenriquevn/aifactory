CREATE TABLE "watch" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"repository" text NOT NULL,
	"sha" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"tag" text,
	"status" text DEFAULT 'watching' NOT NULL,
	"revert_url" text,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "watch" ADD CONSTRAINT "watch_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;