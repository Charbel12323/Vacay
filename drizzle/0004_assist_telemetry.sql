CREATE TABLE "assist_opens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant" text NOT NULL,
	"had_data" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "assist_opens_merchant_idx" ON "assist_opens" USING btree ("merchant","created_at");