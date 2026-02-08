export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS podcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rss_url TEXT NOT NULL UNIQUE,
  description TEXT,
  author TEXT,
  image_url TEXT,
  language TEXT DEFAULT 'zh-CN',
  category TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  podcast_id INTEGER NOT NULL,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  audio_url TEXT,
  audio_format TEXT,
  duration_seconds INTEGER,
  published_at TEXT NOT NULL,
  file_size INTEGER,
  status TEXT DEFAULT 'pending',
  processed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (podcast_id) REFERENCES podcasts(id) ON DELETE CASCADE,
  UNIQUE(podcast_id, guid)
);

CREATE TABLE IF NOT EXISTS analysis_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  key_points TEXT NOT NULL,
  arguments TEXT NOT NULL,
  knowledge_points TEXT NOT NULL,
  transcript TEXT,
  markdown_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  total_episodes INTEGER DEFAULT 0,
  processed_episodes INTEGER DEFAULT 0,
  failed_episodes INTEGER DEFAULT 0,
  error_details TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_episodes_podcast_id ON episodes(podcast_id);
CREATE INDEX IF NOT EXISTS idx_episodes_published_at ON episodes(published_at);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_analysis_episode_id ON analysis_results(episode_id);
CREATE INDEX IF NOT EXISTS idx_task_logs_started_at ON task_logs(started_at);
`;
