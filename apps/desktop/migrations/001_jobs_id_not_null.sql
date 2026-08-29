-- Add NOT NULL constraint to jobs.id (SQLite requires table rebuild).
-- Also removes any remaining ghost rows with NULL id.

DELETE FROM jobs WHERE id IS NULL;

CREATE TABLE jobs_new (
  id TEXT NOT NULL PRIMARY KEY,
  customerName TEXT DEFAULT '',
  phoneNumber TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  fileName TEXT,
  fileType TEXT,
  fileSize INTEGER,
  uploadDate TEXT,
  status TEXT DEFAULT 'PENDING',
  serverFileName TEXT,
  pageCount INTEGER,
  colorMode TEXT DEFAULT 'color',
  copies INTEGER DEFAULT 1,
  paperType TEXT DEFAULT 'normal',
  source TEXT DEFAULT 'upload',
  customerEmail TEXT DEFAULT '',
  paymentStatus TEXT DEFAULT 'UNPAID',
  paymentAmount REAL,
  paymentDate TEXT,
  cloudOrderId TEXT,
  gmailMessageId TEXT,
  notifiedReadyAt TEXT,
  deleteTokenHash TEXT
);

INSERT INTO jobs_new SELECT
  id, customerName, phoneNumber, notes, fileName, fileType, fileSize,
  uploadDate, status, serverFileName, pageCount, colorMode, copies,
  paperType, source, customerEmail, paymentStatus, paymentAmount,
  paymentDate, cloudOrderId, gmailMessageId, notifiedReadyAt, deleteTokenHash
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
