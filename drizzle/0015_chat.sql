CREATE TABLE "chat" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"model" text DEFAULT 'openrouter' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"chat_id" text NOT NULL,
	"position" integer NOT NULL,
	"id" text NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	CONSTRAINT "chat_message_chat_id_position_pk" PRIMARY KEY("chat_id","position")
);
--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;