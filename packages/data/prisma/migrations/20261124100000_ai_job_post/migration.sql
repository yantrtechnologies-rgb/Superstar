-- AI images and videos can be created for a specific post and attached to it when ready.
ALTER TABLE "ai_jobs" ADD COLUMN "post_id" UUID;
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ai_jobs_post_id_idx" ON "ai_jobs"("post_id");
