CREATE TABLE "agent_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"role" text NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"tool" text,
	"content" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_event_task_seq" UNIQUE("task_id","seq")
);
--> statement-breakpoint
ALTER TABLE "agent_event" ADD CONSTRAINT "agent_event_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;