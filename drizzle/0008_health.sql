CREATE TABLE "agent_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"role" text NOT NULL,
	"harness" text NOT NULL,
	"attempt" integer NOT NULL,
	"cost_usd" real,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"quota" boolean DEFAULT false NOT NULL,
	"session_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"task_id" integer,
	"ref" text,
	"detail" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "finding_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;