CREATE TABLE IF NOT EXISTS research_papers (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  level       TEXT NOT NULL DEFAULT 'middle',
  language    TEXT NOT NULL DEFAULT 'ar',
  data        TEXT NOT NULL DEFAULT '{}',
  createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_research_title ON research_papers(title);
CREATE INDEX IF NOT EXISTS idx_research_subject ON research_papers(subject);
