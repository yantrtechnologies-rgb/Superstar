-- Client connect links: an agency sends a link, the client connects their own account without a Superstar account.
CREATE TABLE "connect_links" (
    "hash" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "connect_links_pkey" PRIMARY KEY ("hash")
);

CREATE INDEX "connect_links_workspace_id_expires_at_idx" ON "connect_links"("workspace_id", "expires_at");

ALTER TABLE "connect_links" ADD CONSTRAINT "connect_links_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connect_links" ADD CONSTRAINT "connect_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "oauth_states" ADD COLUMN "connect_link_hash" TEXT;
CREATE INDEX "oauth_states_connect_link_hash_expires_at_idx" ON "oauth_states"("connect_link_hash", "expires_at");
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_connect_link_hash_fkey" FOREIGN KEY ("connect_link_hash") REFERENCES "connect_links"("hash") ON DELETE CASCADE ON UPDATE CASCADE;
