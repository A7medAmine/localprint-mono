-- Groups every file from one upload submission into a single order. Set once
-- per submit batch on the client and shared by every file it contains, so
-- files that finish uploading -- and so arrive at the server -- at different
-- times still belong to one order instead of splitting into one order per
-- file. Backfilled to each existing row's own id so old orders keep grouping
-- as a lone-file order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_id TEXT;
UPDATE orders SET order_id = id WHERE order_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id);
