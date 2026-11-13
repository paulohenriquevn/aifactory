CREATE TABLE "metric_point" (
	"metric" text NOT NULL,
	"repository" text NOT NULL,
	"day" text NOT NULL,
	"value" real NOT NULL,
	"samples" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_point_metric_repository_day_pk" PRIMARY KEY("metric","repository","day")
);
--> statement-breakpoint
CREATE TABLE "metric_signal" (
	"id" serial PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"repository" text NOT NULL,
	"day" text NOT NULL,
	"rule" text NOT NULL,
	"tier" text NOT NULL,
	"value" real NOT NULL,
	"mean" real NOT NULL,
	"sd" real NOT NULL,
	"issue_url" text,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_signal_once" UNIQUE("metric","repository","day","rule")
);
