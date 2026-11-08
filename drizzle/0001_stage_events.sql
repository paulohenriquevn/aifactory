CREATE TABLE "stage_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"stage" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stage_event" ADD CONSTRAINT "stage_event_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;