CREATE TABLE "plan" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"error" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"milestone_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"selected" boolean DEFAULT true NOT NULL,
	"issue_number" integer,
	"issue_url" text,
	"started" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"checks" jsonb,
	"egress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"harness" text,
	"reviewer" text,
	"release_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_plan_id_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plan"("id") ON DELETE cascade ON UPDATE no action;