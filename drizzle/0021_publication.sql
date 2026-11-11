CREATE TABLE "publication" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"repository" text NOT NULL,
	"release_branch" text NOT NULL,
	"promoted_sha" text NOT NULL,
	"actor" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"version_pull_request" integer,
	"tags" jsonb,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "publication_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;