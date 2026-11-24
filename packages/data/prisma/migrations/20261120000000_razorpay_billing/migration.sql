CREATE TABLE "razorpay_subscriptions" (
  "workspace_id" UUID PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "razorpay_subscription_id" TEXT NOT NULL UNIQUE,
  "plan_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "short_url" TEXT,
  "current_end" TIMESTAMP(3),
  "cancel_at_cycle_end" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "razorpay_events" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "razorpay_events_workspace_id_idx" ON "razorpay_events"("workspace_id");
