-- RSS rules can send each new item through AI (topic filter + post writer).
ALTER TABLE "rss_rules" ADD COLUMN "ai_topic" TEXT;
ALTER TABLE "rss_rules" ADD COLUMN "ai_instructions" TEXT;
ALTER TABLE "rss_rules" ADD COLUMN "ai_image" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "feed_items" ADD COLUMN "ai_state" TEXT;
ALTER TABLE "feed_items" ADD COLUMN "ai_note" TEXT;
ALTER TABLE "feed_items" ADD COLUMN "title" TEXT;
ALTER TABLE "feed_items" ADD COLUMN "source_text" TEXT;
ALTER TABLE "posts" ADD COLUMN "ai_note" TEXT;
