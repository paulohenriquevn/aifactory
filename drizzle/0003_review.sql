CREATE TABLE "review" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"round" integer NOT NULL,
	"sha" text NOT NULL,
	"reviewer" text NOT NULL,
	"verdict" text NOT NULL,
	"summary" text NOT NULL,
	"findings" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review" ADD CONSTRAINT "review_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;