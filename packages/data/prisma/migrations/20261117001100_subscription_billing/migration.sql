CREATE TABLE "billing_accounts" (
  "workspace_id" UUID PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "stripe_customer_id" TEXT NOT NULL UNIQUE,
  "stripe_subscription_id" TEXT UNIQUE,
  "price_id" TEXT,
  "status" TEXT,
  "period_end" TIMESTAMP(3),
  "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "stripe_events" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "workspace_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "stripe_events_workspace_id_idx" ON "stripe_events"("workspace_id");
