CREATE TABLE "release_wait" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"repository" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"pull_request_url" text NOT NULL,
	"sha" text NOT NULL,
	"release_branch" text NOT NULL,
	"bump" text NOT NULL,
	"actor" text NOT NULL,
	"changesets" boolean NOT NULL,
	"checks" jsonb NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "release_wait" ADD CONSTRAINT "release_wait_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "release_wait_one_per_repository" ON "release_wait" USING btree ("repository") WHERE "release_wait"."status" = 'waiting';