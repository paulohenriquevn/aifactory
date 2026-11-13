CREATE TABLE "promotion_finding" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository" text NOT NULL,
	"check_name" text NOT NULL,
	"signature" text NOT NULL,
	"issue_number" integer,
	"issue_url" text,
	"for_factory" boolean NOT NULL,
	"last_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_finding_unique" UNIQUE("repository","check_name","signature")
);
