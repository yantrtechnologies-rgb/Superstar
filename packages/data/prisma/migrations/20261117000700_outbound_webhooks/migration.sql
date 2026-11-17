-- CreateEnum
CREATE TYPE "WebhookDeliveryState" AS ENUM ('QUEUED', 'SENDING', 'DELIVERED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "signing_secret" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "state" "WebhookDeliveryState" NOT NULL DEFAULT 'QUEUED',
    "attempts_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leased_until" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_code" INTEGER,
    "error" TEXT,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "state" "WebhookDeliveryState" NOT NULL,
    "status_code" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscriptions_workspace_id_endpoint_key" ON "webhook_subscriptions"("workspace_id", "endpoint");

-- CreateIndex
CREATE INDEX "webhook_deliveries_state_dispatched_at_next_attempt_at_idx" ON "webhook_deliveries"("state", "dispatched_at", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_subscription_id_event_id_key" ON "webhook_deliveries"("subscription_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_attempts_delivery_id_number_key" ON "webhook_attempts"("delivery_id", "number");

-- AddForeignKey
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
