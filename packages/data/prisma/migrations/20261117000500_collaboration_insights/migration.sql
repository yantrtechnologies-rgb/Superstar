-- CreateEnum
CREATE TYPE "MetricJobState" AS ENUM ('QUEUED', 'COLLECTED', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "client_group_id" UUID;

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "review_link_id" UUID,
ALTER COLUMN "reviewer_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "review_links" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "review_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_comments" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "review_link_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_groups" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "client_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting_slots" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,

    CONSTRAINT "posting_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_jobs" (
    "id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "dispatched_at" TIMESTAMP(3),
    "state" "MetricJobState" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,

    CONSTRAINT "metric_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metrics_snapshots" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "count" INTEGER NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metrics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_links_hash_key" ON "review_links"("hash");

-- CreateIndex
CREATE INDEX "review_links_post_id_revision_idx" ON "review_links"("post_id", "revision");

-- CreateIndex
CREATE INDEX "editorial_comments_post_id_revision_created_at_idx" ON "editorial_comments"("post_id", "revision", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "client_groups_workspace_id_name_key" ON "client_groups"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "posting_slots_channel_id_weekday_minute_key" ON "posting_slots"("channel_id", "weekday", "minute");

-- CreateIndex
CREATE INDEX "metric_jobs_dispatched_at_bucket_idx" ON "metric_jobs"("dispatched_at", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "metric_jobs_channel_id_bucket_key" ON "metric_jobs"("channel_id", "bucket");

-- CreateIndex
CREATE UNIQUE INDEX "metrics_snapshots_job_id_key" ON "metrics_snapshots"("job_id");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_client_group_id_fkey" FOREIGN KEY ("client_group_id") REFERENCES "client_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_review_link_id_fkey" FOREIGN KEY ("review_link_id") REFERENCES "review_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_links" ADD CONSTRAINT "review_links_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_comments" ADD CONSTRAINT "editorial_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_comments" ADD CONSTRAINT "editorial_comments_review_link_id_fkey" FOREIGN KEY ("review_link_id") REFERENCES "review_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_groups" ADD CONSTRAINT "client_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_slots" ADD CONSTRAINT "posting_slots_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_jobs" ADD CONSTRAINT "metric_jobs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metrics_snapshots" ADD CONSTRAINT "metrics_snapshots_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "metric_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
