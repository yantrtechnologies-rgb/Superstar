-- CreateEnum
CREATE TYPE "AiKind" AS ENUM ('TEXT', 'IMAGE');

-- CreateEnum
CREATE TYPE "AiJobState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "CreditEntryKind" AS ENUM ('GRANT', 'RESERVE', 'CAPTURE', 'REFUND');

-- CreateEnum
CREATE TYPE "RssRunState" AS ENUM ('QUEUED', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "credit_accounts" (
    "workspace_id" UUID NOT NULL,
    "available" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" "CreditEntryKind" NOT NULL,
    "delta" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" "AiKind" NOT NULL,
    "state" "AiJobState" NOT NULL DEFAULT 'QUEUED',
    "prompt" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "output_text" TEXT,
    "asset_id" UUID,
    "provider_ref" TEXT,
    "error" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rss_rules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rss_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rss_runs" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "state" "RssRunState" NOT NULL DEFAULT 'QUEUED',
    "imported" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),

    CONSTRAINT "rss_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_items" (
    "rule_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "post_id" UUID,

    CONSTRAINT "feed_items_pkey" PRIMARY KEY ("rule_id","source_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_ledger_reference_key" ON "credit_ledger"("reference");

-- CreateIndex
CREATE INDEX "credit_ledger_workspace_id_created_at_idx" ON "credit_ledger"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_jobs_workspace_id_created_at_idx" ON "ai_jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_jobs_dispatched_at_created_at_idx" ON "ai_jobs"("dispatched_at", "created_at");

-- CreateIndex
CREATE INDEX "ai_jobs_state_started_at_idx" ON "ai_jobs"("state", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_workspace_id_request_id_key" ON "ai_jobs"("workspace_id", "request_id");

-- CreateIndex
CREATE INDEX "rss_rules_enabled_next_run_at_idx" ON "rss_rules"("enabled", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "rss_rules_workspace_id_source_url_key" ON "rss_rules"("workspace_id", "source_url");

-- CreateIndex
CREATE INDEX "rss_runs_dispatched_at_created_at_idx" ON "rss_runs"("dispatched_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "rss_runs_rule_id_bucket_key" ON "rss_runs"("rule_id", "bucket");

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "credit_accounts"("workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rss_rules" ADD CONSTRAINT "rss_rules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rss_runs" ADD CONSTRAINT "rss_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rss_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rss_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
