import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';
import { SCHEMA_SQL } from './schema';

export interface Podcast {
  id: number;
  name: string;
  rss_url: string;
  description: string | null;
  author: string | null;
  image_url: string | null;
  language: string;
  category: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: number;
  podcast_id: number;
  guid: string;
  title: string;
  description: string | null;
  audio_url: string | null;
  audio_format: string | null;
  duration_seconds: number | null;
  published_at: string;
  file_size: number | null;
  status: string;
  processed_at: string | null;
  created_at: string;
}

export interface AnalysisResult {
  id: number;
  episode_id: number;
  summary: string;
  key_points: string;
  arguments: string;
  knowledge_points: string;
  transcript: string | null;
  markdown_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLog {
  id: number;
  task_type: string;
  status: string;
  total_episodes: number;
  processed_episodes: number;
  failed_episodes: number;
  error_details: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

class DatabaseManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
    logger.info('Database initialized', { path: dbPath });
  }

  private initialize(): void {
    this.db.exec(SCHEMA_SQL);
  }

  // === Podcasts ===

  getAllPodcasts(): Podcast[] {
    return this.db.prepare('SELECT * FROM podcasts ORDER BY created_at DESC').all() as Podcast[];
  }

  getActivePodcasts(): Podcast[] {
    return this.db.prepare('SELECT * FROM podcasts WHERE is_active = 1 ORDER BY name').all() as Podcast[];
  }

  getPodcastById(id: number): Podcast | undefined {
    return this.db.prepare('SELECT * FROM podcasts WHERE id = ?').get(id) as Podcast | undefined;
  }

  getPodcastByUrl(rssUrl: string): Podcast | undefined {
    return this.db.prepare('SELECT * FROM podcasts WHERE rss_url = ?').get(rssUrl) as Podcast | undefined;
  }

  addPodcast(data: {
    name: string;
    rss_url: string;
    description?: string;
    author?: string;
    image_url?: string;
    language?: string;
    category?: string;
  }): Podcast {
    const stmt = this.db.prepare(`
      INSERT INTO podcasts (name, rss_url, description, author, image_url, language, category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.name, data.rss_url, data.description || null, data.author || null,
      data.image_url || null, data.language || 'zh-CN', data.category || null
    );
    return this.getPodcastById(result.lastInsertRowid as number)!;
  }

  updatePodcast(id: number, data: Partial<Pick<Podcast, 'name' | 'description' | 'author' | 'image_url' | 'language' | 'category' | 'is_active'>>): void {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");
    values.push(id);
    this.db.prepare(`UPDATE podcasts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deletePodcast(id: number): void {
    this.db.prepare('DELETE FROM podcasts WHERE id = ?').run(id);
  }

  // === Episodes ===

  getEpisodesByPodcast(podcastId: number, limit = 50): Episode[] {
    return this.db.prepare(
      'SELECT * FROM episodes WHERE podcast_id = ? ORDER BY published_at DESC LIMIT ?'
    ).all(podcastId, limit) as Episode[];
  }

  getEpisodeByGuid(podcastId: number, guid: string): Episode | undefined {
    return this.db.prepare(
      'SELECT * FROM episodes WHERE podcast_id = ? AND guid = ?'
    ).get(podcastId, guid) as Episode | undefined;
  }

  getEpisodeById(id: number): Episode | undefined {
    return this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as Episode | undefined;
  }

  getNewEpisodes(podcastId: number, sinceHours: number): Episode[] {
    return this.db.prepare(`
      SELECT * FROM episodes
      WHERE podcast_id = ? AND published_at >= datetime('now', ?)
      AND status = 'pending'
      ORDER BY published_at DESC
    `).all(podcastId, `-${sinceHours} hours`) as Episode[];
  }

  getPendingEpisodesByPodcast(podcastId: number, limit = 10): Episode[] {
    return this.db.prepare(`
      SELECT * FROM episodes
      WHERE podcast_id = ? AND status = 'pending' AND audio_url IS NOT NULL
      ORDER BY published_at DESC LIMIT ?
    `).all(podcastId, limit) as Episode[];
  }

  getPendingEpisodes(limit = 20): (Episode & { podcast_name: string })[] {
    return this.db.prepare(`
      SELECT e.*, p.name as podcast_name FROM episodes e
      JOIN podcasts p ON e.podcast_id = p.id
      WHERE e.status = 'pending' AND e.audio_url IS NOT NULL
      ORDER BY e.published_at DESC LIMIT ?
    `).all(limit) as (Episode & { podcast_name: string })[];
  }

  addEpisode(data: {
    podcast_id: number;
    guid: string;
    title: string;
    description?: string;
    audio_url?: string;
    audio_format?: string;
    duration_seconds?: number;
    published_at: string;
    file_size?: number;
  }): Episode | null {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO episodes
        (podcast_id, guid, title, description, audio_url, audio_format, duration_seconds, published_at, file_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        data.podcast_id, data.guid, data.title, data.description || null,
        data.audio_url || null, data.audio_format || null, data.duration_seconds || null,
        data.published_at, data.file_size || null
      );
      if (result.changes === 0) return null;
      return this.getEpisodeById(result.lastInsertRowid as number)!;
    } catch (error) {
      logger.warn('Failed to add episode', { guid: data.guid, error: (error as Error).message });
      return null;
    }
  }

  updateEpisodeStatus(id: number, status: string): void {
    const processedAt = status === 'completed' ? "datetime('now')" : 'NULL';
    this.db.prepare(
      `UPDATE episodes SET status = ?, processed_at = ${processedAt} WHERE id = ?`
    ).run(status, id);
  }

  getCompletedEpisodesSince(sinceHours: number): Episode[] {
    return this.db.prepare(`
      SELECT * FROM episodes
      WHERE status = 'completed'
      AND processed_at >= datetime('now', ?)
      ORDER BY processed_at DESC
    `).all(`-${sinceHours} hours`) as Episode[];
  }

  getCompletedEpisodesWithDocs(): { episode_id: number; podcast_name: string; episode_title: string; published_at: string; processed_at: string; markdown_path: string }[] {
    return this.db.prepare(`
      SELECT e.id as episode_id, p.name as podcast_name, e.title as episode_title, e.published_at, e.processed_at, a.markdown_path
      FROM episodes e
      JOIN podcasts p ON e.podcast_id = p.id
      JOIN analysis_results a ON e.id = a.episode_id
      WHERE a.markdown_path IS NOT NULL
      ORDER BY e.processed_at DESC
    `).all() as any[];
  }

  /** 通过播客名和发布日期反查 episodeId（用于没有 analysis_results 的文件） */
  findEpisodeByPodcastAndDate(podcastName: string, publishedDate: string): { episode_id: number } | undefined {
    return this.db.prepare(`
      SELECT e.id as episode_id
      FROM episodes e
      JOIN podcasts p ON e.podcast_id = p.id
      WHERE p.name = ? AND e.published_at LIKE ?
      LIMIT 1
    `).get(podcastName, `${publishedDate}%`) as any;
  }

  /** 获取指定时间范围内 pending 状态的剧集（带播客名） */
  getPendingEpisodesSince(sinceHours: number): (Episode & { podcast_name: string })[] {
    return this.db.prepare(`
      SELECT e.*, p.name as podcast_name FROM episodes e
      JOIN podcasts p ON e.podcast_id = p.id
      WHERE e.status = 'pending' AND e.audio_url IS NOT NULL
      AND e.published_at >= datetime('now', ?)
      ORDER BY e.published_at DESC
    `).all(`-${sinceHours} hours`) as (Episode & { podcast_name: string })[];
  }

  /** 获取所有失败的剧集（带播客名） */
  getFailedEpisodes(): (Episode & { podcast_name: string })[] {
    return this.db.prepare(`
      SELECT e.*, p.name as podcast_name FROM episodes e
      JOIN podcasts p ON e.podcast_id = p.id
      WHERE e.status = 'failed' AND e.audio_url IS NOT NULL
      ORDER BY e.published_at DESC
    `).all() as (Episode & { podcast_name: string })[];
  }

  /** 批量重置失败剧集为 pending（同时删除旧的分析结果） */
  resetFailedEpisodes(): number {
    const failed = this.getFailedEpisodes();
    for (const ep of failed) {
      this.deleteAnalysisResult(ep.id);
    }
    const result = this.db.prepare(`
      UPDATE episodes SET status = 'pending', processed_at = NULL
      WHERE status = 'failed' AND audio_url IS NOT NULL
    `).run();
    return result.changes;
  }

  deleteAnalysisResult(episodeId: number): void {
    this.db.prepare('DELETE FROM analysis_results WHERE episode_id = ?').run(episodeId);
  }

  // === Analysis Results ===

  getAnalysisResult(episodeId: number): AnalysisResult | undefined {
    return this.db.prepare(
      'SELECT * FROM analysis_results WHERE episode_id = ?'
    ).get(episodeId) as AnalysisResult | undefined;
  }

  saveAnalysisResult(data: {
    episode_id: number;
    summary: string;
    key_points: string;
    arguments: string;
    knowledge_points: string;
    transcript?: string;
    markdown_path?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO analysis_results
      (episode_id, summary, key_points, arguments, knowledge_points, transcript, markdown_path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      data.episode_id, data.summary, data.key_points, data.arguments,
      data.knowledge_points, data.transcript || null, data.markdown_path || null
    );
  }

  // === Task Logs ===

  createTaskLog(taskType: string): number {
    const result = this.db.prepare(
      "INSERT INTO task_logs (task_type) VALUES (?)"
    ).run(taskType);
    return result.lastInsertRowid as number;
  }

  updateTaskLog(id: number, data: {
    status?: string;
    total_episodes?: number;
    processed_episodes?: number;
    failed_episodes?: number;
    error_details?: string;
  }): void {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (data.status === 'completed' || data.status === 'failed') {
      fields.push("completed_at = datetime('now')");
      fields.push("duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)");
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE task_logs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getTaskLogs(limit = 50): TaskLog[] {
    return this.db.prepare(
      'SELECT * FROM task_logs ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as TaskLog[];
  }

  // === Statistics ===

  getStats(): {
    totalPodcasts: number;
    activePodcasts: number;
    totalEpisodes: number;
    processedEpisodes: number;
    pendingEpisodes: number;
    failedEpisodes: number;
  } {
    const podcasts = this.db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active FROM podcasts').get() as any;
    const episodes = this.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as processed,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM episodes
    `).get() as any;

    return {
      totalPodcasts: podcasts.total || 0,
      activePodcasts: podcasts.active || 0,
      totalEpisodes: episodes.total || 0,
      processedEpisodes: episodes.processed || 0,
      pendingEpisodes: episodes.pending || 0,
      failedEpisodes: episodes.failed || 0,
    };
  }

  // === Search & Chat Helpers ===

  /** 全局搜索：在剧集标题、摘要、要点、关键词、纪要中匹配关键词 */
  searchEpisodesByKeyword(keyword: string, limit = 20): Array<{
    episode_id: number; podcast_name: string; episode_title: string;
    published_at: string; summary: string; key_points: string;
    arguments: string; knowledge_points: string;
  }> {
    const kw = `%${keyword}%`;
    return this.db.prepare(`
      SELECT e.id as episode_id, p.name as podcast_name, e.title as episode_title,
             e.published_at, a.summary, a.key_points, a.arguments, a.knowledge_points
      FROM analysis_results a
      JOIN episodes e ON e.id = a.episode_id
      JOIN podcasts p ON p.id = e.podcast_id
      WHERE e.title LIKE ?
         OR a.summary LIKE ?
         OR a.key_points LIKE ?
         OR a.arguments LIKE ?
         OR a.knowledge_points LIKE ?
      ORDER BY e.published_at DESC
      LIMIT ?
    `).all(kw, kw, kw, kw, kw, limit) as any[];
  }

  /** 获取某个播客的所有已分析剧集（用于播客作用域对话） */
  getAnalyzedEpisodesByPodcast(podcastId: number, limit = 30): Array<{
    episode_id: number; episode_title: string; published_at: string;
    summary: string; key_points: string;
  }> {
    return this.db.prepare(`
      SELECT e.id as episode_id, e.title as episode_title, e.published_at,
             a.summary, a.key_points
      FROM analysis_results a
      JOIN episodes e ON e.id = a.episode_id
      WHERE e.podcast_id = ?
      ORDER BY e.published_at DESC
      LIMIT ?
    `).all(podcastId, limit) as any[];
  }

  /** 获取单一剧集的完整分析（用于剧集作用域对话） */
  getEpisodeFullAnalysis(episodeId: number): {
    podcast_name: string; episode_title: string; published_at: string;
    summary: string; key_points: string; arguments: string;
    knowledge_points: string; transcript: string | null;
  } | undefined {
    return this.db.prepare(`
      SELECT p.name as podcast_name, e.title as episode_title, e.published_at,
             a.summary, a.key_points, a.arguments, a.knowledge_points, a.transcript
      FROM analysis_results a
      JOIN episodes e ON e.id = a.episode_id
      JOIN podcasts p ON p.id = e.podcast_id
      WHERE e.id = ?
    `).get(episodeId) as any;
  }

  /** 统计若干时间窗口内已完成剧集（用于"立即发送摘要"前的预览） */
  countCompletedSinceWindows(): { last24h: number; last72h: number; last168h: number } {
    const r24 = this.db.prepare(`SELECT COUNT(*) as c FROM episodes WHERE status='completed' AND processed_at >= datetime('now','-24 hours')`).get() as any;
    const r72 = this.db.prepare(`SELECT COUNT(*) as c FROM episodes WHERE status='completed' AND processed_at >= datetime('now','-72 hours')`).get() as any;
    const r168 = this.db.prepare(`SELECT COUNT(*) as c FROM episodes WHERE status='completed' AND processed_at >= datetime('now','-168 hours')`).get() as any;
    return { last24h: r24.c || 0, last72h: r72.c || 0, last168h: r168.c || 0 };
  }

  // === Daily Digests ===

  saveDailyDigest(date: string, summary: string, audioFilename: string | null, episodeIds: number[]): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO daily_digests (date, summary, audio_filename, episode_ids)
      VALUES (?, ?, ?, ?)
    `).run(date, summary, audioFilename, JSON.stringify(episodeIds));
  }

  getDailyDigest(date: string): { id: number; date: string; summary: string | null; audio_filename: string | null; episode_ids: string | null; created_at: string } | undefined {
    return this.db.prepare('SELECT * FROM daily_digests WHERE date = ?').get(date) as any;
  }

  listDailyDigests(limit = 30): { date: string; has_summary: number; has_audio: number; created_at: string }[] {
    return this.db.prepare(`
      SELECT date,
        CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END as has_summary,
        CASE WHEN audio_filename IS NOT NULL THEN 1 ELSE 0 END as has_audio,
        created_at
      FROM daily_digests
      ORDER BY date DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  close(): void {
    this.db.close();
  }
}

let instance: DatabaseManager | null = null;

export function getDatabase(): DatabaseManager {
  if (!instance) {
    instance = new DatabaseManager(config.database.path);
  }
  return instance;
}
