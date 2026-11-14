ALTER TABLE "agent_run" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "tokens_in" integer;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "tokens_out" integer;--> statement-breakpoint
CREATE TABLE "agent_setting_change" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"actor" text DEFAULT 'owner' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
