-- CreateEnum
CREATE TYPE "PostState" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'SCHEDULED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PublishState" AS ENUM ('SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'CANCELED', 'FAILED', 'UNCERTAIN');

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" "PostState" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_at" TIMESTAMP(3),

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_revisions" (
    "post_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "channel_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "content" TEXT NOT NULL,
    "asset_id" UUID,

    CONSTRAINT "post_revisions_pkey" PRIMARY KEY ("post_id","number")
);

-- CreateTable
CREATE TABLE "approvals" (
    "post_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("post_id","revision")
);

-- CreateTable
CREATE TABLE "destinations" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "state" "PublishState" NOT NULL DEFAULT 'SCHEDULED',
    "started_at" TIMESTAMP(3),
    "not_before" TIMESTAMP(3),
    "external_id" TEXT,
    "permalink" TEXT,
    "error" TEXT,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL,
    "destination_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "state" "PublishState" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "destination_id" UUID NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "dispatched_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("destination_id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channels_workspace_id_provider_external_id_key" ON "channels"("workspace_id", "provider", "external_id");

-- CreateIndex
CREATE INDEX "posts_workspace_id_scheduled_at_idx" ON "posts"("workspace_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "destinations_post_id_revision_idx" ON "destinations"("post_id", "revision");

-- CreateIndex
CREATE INDEX "destinations_state_started_at_idx" ON "destinations"("state", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_destination_id_number_key" ON "publish_attempts"("destination_id", "number");

-- CreateIndex
CREATE INDEX "outbox_events_dispatched_at_due_at_idx" ON "outbox_events"("dispatched_at", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "assets_key_key" ON "assets"("key");

-- CreateIndex
CREATE INDEX "assets_workspace_id_idx" ON "assets"("workspace_id");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_post_id_revision_fkey" FOREIGN KEY ("post_id", "revision") REFERENCES "post_revisions"("post_id", "number") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
