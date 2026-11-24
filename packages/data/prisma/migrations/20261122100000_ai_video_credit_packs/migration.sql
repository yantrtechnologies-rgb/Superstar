-- AI video generation and credit packs bought through Razorpay.
ALTER TYPE "AiKind" ADD VALUE IF NOT EXISTS 'VIDEO';
ALTER TYPE "CreditEntryKind" ADD VALUE IF NOT EXISTS 'PURCHASE';

CREATE TABLE "credit_purchases" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "pack" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "payment_link_id" TEXT,
    "short_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "payment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    CONSTRAINT "credit_purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_purchases_payment_link_id_key" ON "credit_purchases"("payment_link_id");
CREATE INDEX "credit_purchases_workspace_id_created_at_idx" ON "credit_purchases"("workspace_id", "created_at");

ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
