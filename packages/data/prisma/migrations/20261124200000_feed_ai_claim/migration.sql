-- One AI run per feed item at a time.
ALTER TABLE "feed_items" ADD COLUMN "ai_claimed_at" TIMESTAMP(3);
