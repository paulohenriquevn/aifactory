CREATE TABLE "ingress" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"repository" text,
	"payload" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"code" text NOT NULL,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" serial PRIMARY KEY NOT NULL,
	"ingress_id" integer NOT NULL,
	"repository" text NOT NULL,
	"issue_number" integer NOT NULL,
	"issue_title" text NOT NULL,
	"stage" text DEFAULT 'intake' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_issue_unique" UNIQUE("repository","issue_number")
);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_ingress_id_ingress_id_fk" FOREIGN KEY ("ingress_id") REFERENCES "public"."ingress"("id") ON DELETE no action ON UPDATE no action;