-- Carry the cloud's uploader identifiers onto the local job row so the Admin
-- panel can block the sender of an order it already received, instead of
-- making the operator read an IP off the server logs.
--
-- Both are supplied by the online app's /api/shop/pending payload and are
-- null for locally created (source: 'admin') jobs.
ALTER TABLE jobs ADD COLUMN uploaderIp TEXT;
ALTER TABLE jobs ADD COLUMN uploaderFingerprint TEXT;
