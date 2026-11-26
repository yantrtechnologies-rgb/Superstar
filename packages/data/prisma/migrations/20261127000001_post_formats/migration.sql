-- Per-channel post format (Facebook Reels and Stories, Instagram Stories): { [channelId]: "reel" | "story" }.
ALTER TABLE "post_revisions" ADD COLUMN "formats" JSONB NOT NULL DEFAULT '{}';
