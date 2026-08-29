-- Phase 4.5: enforce NOT NULL on orders.id.
--
-- Postgres PRIMARY KEY columns are implicitly NOT NULL, so this is defensive
-- (it matches the desktop SQLite rebuild that finally kills the ghost-row bug).
-- The server always supplies a crypto.randomUUID() at insert time, so no
-- column default is needed.
alter table orders alter column id set not null;
