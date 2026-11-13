ALTER TABLE "repository" ADD COLUMN "checks_proven_sha" text;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "checks_proven" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "repository" ADD COLUMN "checks_proof" jsonb;