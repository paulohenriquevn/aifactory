CREATE TABLE "knowledge_delivery" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer,
	"plan_id" integer,
	"project" text NOT NULL,
	"knowledge_repository" text NOT NULL,
	"knowledge_sha" text NOT NULL,
	"memory_sha" text,
	"files" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_note" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"task_id" integer NOT NULL,
	"issue_number" integer NOT NULL,
	"base_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_sha" text,
	"committed_at" timestamp with time zone,
	CONSTRAINT "knowledge_note_once" UNIQUE("repository","body_hash")
);
--> statement-breakpoint
ALTER TABLE "knowledge_delivery" ADD CONSTRAINT "knowledge_delivery_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_delivery" ADD CONSTRAINT "knowledge_delivery_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_note" ADD CONSTRAINT "knowledge_note_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;