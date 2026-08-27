-- Phase 1.3 / 1.4 / 1.5

-- Per-upload delete secret. The plaintext token is returned to the uploader
-- exactly once; only its sha256 hash is stored. Deleting an order requires
-- presenting the matching token.
alter table orders add column if not exists delete_token_hash text;

-- Set when a signed-in customer's upload had to be filed as a guest because
-- Supabase auth was briefly unavailable. A later job can reconcile these to
-- the owning account by email/phone.
alter table orders add column if not exists auth_deferred boolean not null default false;

-- Shop provisioning: deactivating a shop without deleting its data.
alter table shops add column if not exists is_active boolean not null default true;
