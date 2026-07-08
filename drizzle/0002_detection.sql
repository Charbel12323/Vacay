ALTER TABLE "subscriptions" ADD COLUMN "stream_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_stream_key_uq" UNIQUE("user_id","stream_key");