-- CreateEnum
CREATE TYPE "RssScheduleState" AS ENUM ('OFF', 'WAITING_REVIEW', 'BLOCKED', 'SCHEDULED');

-- AlterTable
ALTER TABLE "post_revisions" ADD COLUMN     "follow_up_delay_minutes" INTEGER,
ADD COLUMN     "follow_up_text" TEXT;

-- AlterTable
ALTER TABLE "destinations" ADD COLUMN     "parent_id" UUID;

-- AlterTable
ALTER TABLE "rss_rules" ADD COLUMN     "authorized_by_id" UUID,
ADD COLUMN     "channel_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "publish_after_approval" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "feed_items" ADD COLUMN     "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "next_schedule_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "schedule_error" TEXT,
ADD COLUMN     "schedule_state" "RssScheduleState" NOT NULL DEFAULT 'OFF';

-- CreateIndex
CREATE UNIQUE INDEX "destinations_parent_id_key" ON "destinations"("parent_id");

-- CreateIndex
CREATE INDEX "feed_items_schedule_state_next_schedule_at_idx" ON "feed_items"("schedule_state", "next_schedule_at");

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
