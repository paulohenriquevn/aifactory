CREATE TABLE "change_plan" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"base_sha" text NOT NULL,
	"harness" text NOT NULL,
	"plan" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_plan" ADD CONSTRAINT "change_plan_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;