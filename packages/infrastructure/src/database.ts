import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  BRIEF_FIELD_LABELS,
  BootstrapSnapshotSchema,
  LongContextPacketSchema,
  DEFAULT_ROLES,
  OutlineChapterSchema,
  StoryBriefSchema,
  calculateBriefReadiness,
  getWorkflowSteps,
  toValuePreview,
  type Book,
  type BootstrapSnapshot,
  type Chapter,
  type ChapterSummary,
  type ChatMessage,
  type CreateBookInput,
  type CreateChapterInput,
  type CreateSeriesInput,
  type OutlineChapter,
  type OutlineVersion,
  type BillingState,
  type CostStatus,
  type ProviderKind,
  type ProviderRoute,
  type LongContextPacket,
  type StoryBrief,
  type UpdateBookInput,
  type UpdateChapterInput,
  type UpdateSeriesInput,
  type WorkflowArtifact,
  type WorkflowArtifactKind,
  type WorkflowPreset,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStep
} from '@core/index'
import { buildLongContextPacket, estimateTokens, rebudgetLongContextPacket, summarizeChapter } from './context'
import type { ProviderRequestEvent } from './providers'
import { CURRENT_SCHEMA_VERSION, createMigrationBackup } from './recovery'

type SqlRow = Record<string, unknown>

export type WorkflowStepLease = {
  runId: string
  stepId: string
  attemptId: string
  attempt: number
  ordinal: number
  roleId: string
  kind: WorkflowArtifactKind
  label: string
  provider: ProviderKind
  model: string
  inputCostPerMillion: number | null
  outputCostPerMillion: number | null
  contextTokenBudget: number
  chapter: Chapter
  brief: StoryBrief
  outline: OutlineChapter
  canon: BootstrapSnapshot['canon']
  previousArtifacts: WorkflowArtifact[]
  contextPacket: LongContextPacket
}

export type WorkflowArtifactDraft = {
  title: string
  summary: string
  data: Record<string, unknown>
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  provider: ProviderKind
  model: string
  requestId: string | null
  httpStatus: number | null
  retryCount: number
  costStatus: CostStatus
}

export type WorkflowFailureMetadata = {
  billingState: BillingState
  requestId: string
  httpStatus: number | null
  retryCount: number
  retryAt: string | null
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
  costStatus?: CostStatus
  provider?: ProviderKind
  model?: string
}

const DEMO_SERIES_ID = 'series-van-menh-ky-uc'
const DEMO_BOOK_ID = 'book-thanh-pho-khong-ten'

const INITIAL_BRIEF: StoryBrief = StoryBriefSchema.parse({
  premise: 'Trong một thành phố nơi ký ức được lưu giữ bằng ánh sáng, một thủ thư trẻ phát hiện cả thành phố đang quên cùng một cái tên.',
  genres: ['Kỳ ảo', 'Bí ẩn'],
  audience: 'Độc giả trưởng thành yêu thích kỳ ảo giàu cảm xúc',
  setting: 'Thành phố nổi Lam Kính, nơi ký ức được cất trong những ngọn đèn thủy tinh',
  protagonists: ['An — thủ thư ký ức, 24 tuổi'],
  conflict: 'Mỗi ký ức An khôi phục sẽ khiến cô đánh mất một ký ức của chính mình.',
  pointOfView: 'Ngôi ba giới hạn theo An',
  tense: 'Quá khứ',
  tone: 'U hoài, bí ẩn nhưng có ánh sáng hy vọng',
  targetChapters: 24,
  endingDirection: '',
  mustInclude: ['Biểu tượng đèn thủy tinh', 'Mối quan hệ chị em bị lãng quên'],
  mustAvoid: ['Giải thích phép thuật bằng công nghệ hiện đại'],
  contentLimits: 'Không mô tả bạo lực quá chi tiết'
})

const INITIAL_OUTLINE = [
  ['Ngọn đèn tắt', 'An phát hiện một ngọn đèn ký ức không còn tên chủ nhân.'],
  ['Người không có bóng', 'Một vị khách bí ẩn nhận ra ký ức trong chiếc đèn.'],
  ['Bản đồ những điều đã quên', 'Dấu vết dẫn đến khu phố đã bị xóa khỏi mọi bản đồ.'],
  ['Lời thề dưới tháp chuông', 'An biết cái giá thật sự của năng lực khôi phục ký ức.'],
  ['Đêm thủy tinh vỡ', 'Thành phố đồng loạt mất ký ức về một biến cố cũ.'],
  ['Cái tên đầu tiên', 'An lựa chọn ký ức nào phải được cứu trước.']
] as const

export class NovelDatabase {
  readonly path: string
  private readonly db: DatabaseSync
  private closed = false

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true })
    this.path = join(dataDirectory, 'novel-agent.sqlite')
    const databaseExisted = existsSync(this.path)
    this.db = new DatabaseSync(this.path, { timeout: 5000 })
    try {
      this.configure()
      const previousVersion = this.readSchemaVersion()
      if (databaseExisted) {
        const integrity = this.integrityCheck()
        if (integrity !== 'ok') throw new Error(`SQLite integrity_check không đạt: ${integrity}`)
        if (previousVersion > CURRENT_SCHEMA_VERSION) {
          throw new Error(`Database dùng schema v${previousVersion}, mới hơn ứng dụng hiện tại v${CURRENT_SCHEMA_VERSION}.`)
        }
      }
      const migrationBackupPath = databaseExisted && previousVersion > 0 && previousVersion < CURRENT_SCHEMA_VERSION
        ? createMigrationBackup(this.db, dataDirectory, previousVersion)
        : null
      this.migrate()
      if (migrationBackupPath) {
        this.writeRecoveryEvent('migration_backup', 'completed', migrationBackupPath, `Đã bảo toàn schema v${previousVersion} trước khi nâng lên v${CURRENT_SCHEMA_VERSION}.`)
      }
      this.seedDemoWorkspace()
      this.synchronizeChapterSummaries()
      this.interruptActiveWorkflows()
    } catch (error) {
      this.close()
      throw error
    }
  }

  private configure(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
    `)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS series (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        genre TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planning',
        target_chapters INTEGER NOT NULL DEFAULT 24,
        approved_chapters INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned',
        content_json TEXT NOT NULL DEFAULT '{}',
        word_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(book_id, number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chapter_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS brief_versions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        status TEXT NOT NULL,
        origin_version INTEGER,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(book_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS outline_versions (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(book_id, version)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS canon_facts (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        source_chapter INTEGER,
        confidence REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS chapter_summaries (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chapter_number INTEGER NOT NULL,
        chapter_title TEXT NOT NULL,
        source_version INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        key_events_json TEXT NOT NULL DEFAULT '[]',
        characters_json TEXT NOT NULL DEFAULT '[]',
        locations_json TEXT NOT NULL DEFAULT '[]',
        unresolved_threads_json TEXT NOT NULL DEFAULT '[]',
        token_estimate INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        role_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        cost_status TEXT NOT NULL DEFAULT 'not_applicable',
        started_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        outline_version_id TEXT NOT NULL REFERENCES outline_versions(id),
        preset TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step INTEGER NOT NULL DEFAULT 0,
        progress REAL NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '',
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT NOT NULL DEFAULT 'demo',
        model TEXT NOT NULL DEFAULT 'deterministic-v1',
        input_cost_per_million REAL,
        output_cost_per_million REAL,
        context_token_budget INTEGER NOT NULL DEFAULT 16000,
        prompt_version TEXT NOT NULL DEFAULT 'p0.2-v1',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        request_id TEXT,
        http_status INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        retry_at TEXT,
        billing_state TEXT NOT NULL DEFAULT 'not_started',
        cost_status TEXT NOT NULL DEFAULT 'not_applicable',
        input_fingerprint TEXT NOT NULL,
        last_error TEXT,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE(run_id, ordinal)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workflow_attempts (
        id TEXT PRIMARY KEY,
        step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'demo',
        model TEXT NOT NULL DEFAULT 'deterministic-v1',
        request_id TEXT,
        http_status INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        retry_at TEXT,
        billing_state TEXT NOT NULL DEFAULT 'not_started',
        cost_status TEXT NOT NULL DEFAULT 'not_applicable',
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(step_id, attempt)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workflow_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        role_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposal',
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        committed_at TEXT,
        UNIQUE(step_id, kind)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS workflow_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS usage_ledger (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES workflow_attempts(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        request_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        cost_status TEXT NOT NULL DEFAULT 'not_applicable',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        entity_id TEXT,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE VIRTUAL TABLE IF NOT EXISTS manuscript_fts USING fts5(
        entity_id UNINDEXED,
        book_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
        entity_type UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)

    const exists = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 1').get()
    if (!exists) {
      this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(new Date().toISOString())
    }

    const duplicateTitleMigration = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 2').get()
    if (!duplicateTitleMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const chapters = this.db.prepare('SELECT id, title, content_json FROM chapters').all() as SqlRow[]
        const updateChapter = this.db.prepare('UPDATE chapters SET content_json = ? WHERE id = ?')
        chapters.forEach((chapter) => {
          const migratedContent = removeLeadingDuplicateTitle(String(chapter.content_json), String(chapter.title))
          if (migratedContent) updateChapter.run(migratedContent, String(chapter.id))
        })
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)').run(new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    const workspaceMigration = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 3').get()
    if (!workspaceMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.addColumnIfMissing('series', 'archived_at', 'TEXT')
        this.addColumnIfMissing('books', 'archived_at', 'TEXT')
        this.addColumnIfMissing('chapters', 'archived_at', 'TEXT')
        this.addColumnIfMissing('outline_versions', 'origin_version', 'INTEGER')
        this.addColumnIfMissing('outline_versions', 'approved_at', 'TEXT')
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
        `)
        const latestBook = this.db.prepare(`
          SELECT id FROM books WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 1
        `).get() as SqlRow | undefined
        if (latestBook) this.setSetting('active_book_id', String(latestBook.id))
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)').run(new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    const workflowMigration = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 4').get()
    if (!workflowMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.addColumnIfMissing('jobs', 'input_tokens', 'INTEGER NOT NULL DEFAULT 0')
        this.addColumnIfMissing('jobs', 'output_tokens', 'INTEGER NOT NULL DEFAULT 0')
        this.addColumnIfMissing('jobs', 'estimated_cost', 'REAL NOT NULL DEFAULT 0')
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS workflow_runs_book_status_idx ON workflow_runs(book_id, status, updated_at);
          CREATE INDEX IF NOT EXISTS workflow_steps_run_status_idx ON workflow_steps(run_id, status, ordinal);
          CREATE INDEX IF NOT EXISTS workflow_artifacts_run_status_idx ON workflow_artifacts(run_id, status, created_at);
          CREATE INDEX IF NOT EXISTS workflow_events_run_sequence_idx ON workflow_events(run_id, sequence);
        `)
        this.db.prepare(`
          DELETE FROM jobs WHERE label = 'Hoàn thiện định hướng truyện' AND role_id = 'director' AND status = 'waiting_review'
        `).run()
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)').run(new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    const liveProviderMigration = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 5').get()
    if (!liveProviderMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.addColumnIfMissing('jobs', 'cost_status', "TEXT NOT NULL DEFAULT 'not_applicable'")
        this.addColumnIfMissing('workflow_steps', 'input_cost_per_million', 'REAL')
        this.addColumnIfMissing('workflow_steps', 'output_cost_per_million', 'REAL')
        this.addColumnIfMissing('workflow_steps', 'request_id', 'TEXT')
        this.addColumnIfMissing('workflow_steps', 'http_status', 'INTEGER')
        this.addColumnIfMissing('workflow_steps', 'retry_count', 'INTEGER NOT NULL DEFAULT 0')
        this.addColumnIfMissing('workflow_steps', 'retry_at', 'TEXT')
        this.addColumnIfMissing('workflow_steps', 'billing_state', "TEXT NOT NULL DEFAULT 'not_started'")
        this.addColumnIfMissing('workflow_steps', 'cost_status', "TEXT NOT NULL DEFAULT 'not_applicable'")
        this.addColumnIfMissing('workflow_attempts', 'provider', "TEXT NOT NULL DEFAULT 'demo'")
        this.addColumnIfMissing('workflow_attempts', 'model', "TEXT NOT NULL DEFAULT 'deterministic-v1'")
        this.addColumnIfMissing('workflow_attempts', 'request_id', 'TEXT')
        this.addColumnIfMissing('workflow_attempts', 'http_status', 'INTEGER')
        this.addColumnIfMissing('workflow_attempts', 'retry_count', 'INTEGER NOT NULL DEFAULT 0')
        this.addColumnIfMissing('workflow_attempts', 'retry_at', 'TEXT')
        this.addColumnIfMissing('workflow_attempts', 'billing_state', "TEXT NOT NULL DEFAULT 'not_started'")
        this.addColumnIfMissing('workflow_attempts', 'cost_status', "TEXT NOT NULL DEFAULT 'not_applicable'")
        this.addColumnIfMissing('usage_ledger', 'attempt_id', 'TEXT')
        this.addColumnIfMissing('usage_ledger', 'request_id', 'TEXT')
        this.addColumnIfMissing('usage_ledger', 'cost_status', "TEXT NOT NULL DEFAULT 'not_applicable'")
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS workflow_attempts_request_idx ON workflow_attempts(request_id);
          CREATE INDEX IF NOT EXISTS usage_ledger_request_idx ON usage_ledger(request_id);
        `)
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)').run(new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    const longContextMigration = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 6').get()
    if (!longContextMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.addColumnIfMissing('workflow_steps', 'context_token_budget', 'INTEGER NOT NULL DEFAULT 16000')
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chapter_summaries (
            id TEXT PRIMARY KEY,
            chapter_id TEXT NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE,
            book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            chapter_number INTEGER NOT NULL,
            chapter_title TEXT NOT NULL,
            source_version INTEGER NOT NULL DEFAULT 0,
            summary TEXT NOT NULL,
            key_events_json TEXT NOT NULL DEFAULT '[]',
            characters_json TEXT NOT NULL DEFAULT '[]',
            locations_json TEXT NOT NULL DEFAULT '[]',
            unresolved_threads_json TEXT NOT NULL DEFAULT '[]',
            token_estimate INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS chapter_summaries_book_number_idx ON chapter_summaries(book_id, chapter_number);
          CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(
            entity_type UNINDEXED,
            entity_id UNINDEXED,
            book_id UNINDEXED,
            title,
            body,
            tokenize = 'unicode61 remove_diacritics 2'
          );
        `)
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?)').run(new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }

    const recoveryMigration = this.db.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 7').get()
    if (!recoveryMigration) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS recovery_events (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            status TEXT NOT NULL,
            recovery_path TEXT,
            detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS recovery_events_created_idx ON recovery_events(created_at DESC);
        `)
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)').run(new Date().toISOString())
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]
    if (!columns.some((item) => String(item.name) === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString())
  }

  private seedDemoWorkspace(): void {
    const exists = this.db.prepare('SELECT 1 AS value FROM books LIMIT 1').get()
    if (exists) return

    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO series(id, name, description, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(
        DEMO_SERIES_ID,
        'Vận mệnh ký ức',
        'Một series kỳ ảo về những thành phố được dựng nên từ ký ức con người.',
        now,
        now
      )
      this.db.prepare(`
        INSERT INTO books(id, series_id, title, genre, status, target_chapters, approved_chapters, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'planning', 24, 0, ?, ?)
      `).run(DEMO_BOOK_ID, DEMO_SERIES_ID, 'Thành phố không tên', 'Kỳ ảo · Bí ẩn', now, now)

      const insertChapter = this.db.prepare(`
        INSERT INTO chapters(id, book_id, number, title, summary, status, content_json, word_count, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `)
      INITIAL_OUTLINE.forEach(([title, purpose], index) => {
        const content = index === 0
          ? {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Mưa rơi trên mái kính của Lam Kính như những đầu ngón tay đang cố nhớ một giai điệu cũ.' }]
                },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'An đứng một mình giữa kho lưu trữ, trước ngọn đèn duy nhất không còn tên.' }]
                }
              ]
            }
          : { type: 'doc', content: [{ type: 'paragraph' }] }
        insertChapter.run(
          `chapter-${index + 1}`,
          DEMO_BOOK_ID,
          index + 1,
          title,
          purpose,
          index === 0 ? 'drafting' : 'planned',
          JSON.stringify(content),
          now,
          now
        )
      })

      this.db.prepare(`
        INSERT INTO brief_versions(id, book_id, version, data_json, status, created_at)
        VALUES(?, ?, 1, ?, 'draft', ?)
      `).run(randomUUID(), DEMO_BOOK_ID, JSON.stringify(INITIAL_BRIEF), now)

      const outline = INITIAL_OUTLINE.map(([title, purpose], index) => ({
        number: index + 1,
        title,
        purpose,
        status: index === 0 ? 'ready' : 'planned'
      }))
      this.db.prepare(`
        INSERT INTO outline_versions(id, book_id, version, data_json, status, created_at)
        VALUES(?, ?, 1, ?, 'proposal', ?)
      `).run(randomUUID(), DEMO_BOOK_ID, JSON.stringify(outline), now)

      const insertMessage = this.db.prepare('INSERT INTO conversations(id, book_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)')
      insertMessage.run(randomUUID(), DEMO_BOOK_ID, 'director', 'Tôi đã gom những gì chúng ta có thành một định hướng sơ bộ. Trước khi kiến trúc sư khóa dàn ý, bạn muốn câu chuyện kết thúc theo dư vị nào: chữa lành, bi kịch hay một chiến thắng có đánh đổi?', now)

      const insertCanon = this.db.prepare(`
        INSERT INTO canon_facts(id, book_id, category, subject, fact, source_chapter, confidence, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insertCanon.run(randomUUID(), DEMO_BOOK_ID, 'character', 'An', 'Thủ thư ký ức 24 tuổi; có thể nghe thấy ký ức trong đèn thủy tinh.', null, 1, now)
      insertCanon.run(randomUUID(), DEMO_BOOK_ID, 'location', 'Lam Kính', 'Thành phố nổi gồm bảy tầng cầu kính nối quanh tháp chuông.', null, 1, now)
      insertCanon.run(randomUUID(), DEMO_BOOK_ID, 'rule', 'Giá của việc khôi phục', 'Mỗi ký ức được cứu sẽ xóa một ký ức cá nhân của người thực hiện.', null, 0.92, now)
      insertCanon.run(randomUUID(), DEMO_BOOK_ID, 'object', 'Đèn vô danh', 'Ngọn đèn duy nhất trong kho không còn nhãn chủ nhân.', 1, 0.85, now)

      this.setSetting('active_book_id', DEMO_BOOK_ID)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getActiveBookId(): string {
    const selected = this.db.prepare(`
      SELECT b.id FROM app_settings s
      JOIN books b ON b.id = s.value
      JOIN series sr ON sr.id = b.series_id
      WHERE s.key = 'active_book_id' AND b.archived_at IS NULL AND sr.archived_at IS NULL
    `).get() as SqlRow | undefined
    if (selected) return String(selected.id)
    const row = this.db.prepare(`
      SELECT b.id FROM books b JOIN series s ON s.id = b.series_id
      WHERE b.archived_at IS NULL AND s.archived_at IS NULL
      ORDER BY b.updated_at DESC LIMIT 1
    `).get() as SqlRow | undefined
    if (!row) throw new Error('Không tìm thấy dự án đang hoạt động.')
    this.setSetting('active_book_id', String(row.id))
    return String(row.id)
  }

  switchBook(bookId: string): void {
    const book = this.db.prepare(`
      SELECT b.id FROM books b JOIN series s ON s.id = b.series_id
      WHERE b.id = ? AND b.archived_at IS NULL AND s.archived_at IS NULL
    `).get(bookId)
    if (!book) throw new Error('Sách không tồn tại hoặc đã được lưu trữ.')
    this.setSetting('active_book_id', bookId)
  }

  createSeries(input: CreateSeriesInput): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO series(id, name, description, created_at, updated_at) VALUES(?, ?, ?, ?, ?)
      `).run(id, input.name, input.description, now, now)
      this.writeAudit('series.created', id, input)
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateSeries(input: UpdateSeriesInput): void {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE series SET name = ?, description = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL
    `).run(input.name, input.description, now, input.id)
    if (Number(result.changes) === 0) throw new Error('Không tìm thấy series để cập nhật.')
    this.writeAudit('series.updated', input.id, input)
  }

  archiveSeries(id: string): void {
    const series = this.db.prepare('SELECT id FROM series WHERE id = ? AND archived_at IS NULL').get(id)
    if (!series) throw new Error('Series không tồn tại hoặc đã được lưu trữ.')
    const activeBookId = this.getActiveBookId()
    const activeInSeries = this.db.prepare('SELECT 1 AS value FROM books WHERE id = ? AND series_id = ?').get(activeBookId, id)
    const fallback = this.db.prepare(`
      SELECT b.id FROM books b JOIN series s ON s.id = b.series_id
      WHERE b.series_id <> ? AND b.archived_at IS NULL AND s.archived_at IS NULL
      ORDER BY b.updated_at DESC LIMIT 1
    `).get(id) as SqlRow | undefined
    if (activeInSeries && !fallback) throw new Error('Cần ít nhất một sách hoạt động trước khi lưu trữ series này.')

    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE chapters SET archived_at = ?, updated_at = ?
        WHERE book_id IN (SELECT id FROM books WHERE series_id = ?) AND archived_at IS NULL
      `).run(now, now, id)
      this.db.prepare('UPDATE books SET archived_at = ?, updated_at = ? WHERE series_id = ? AND archived_at IS NULL').run(now, now, id)
      this.db.prepare('UPDATE series SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
      if (activeInSeries && fallback) this.setSetting('active_book_id', String(fallback.id))
      this.writeAudit('series.archived', id, { fallbackBookId: fallback ? String(fallback.id) : null })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createBook(input: CreateBookInput): string {
    const series = this.db.prepare('SELECT id FROM series WHERE id = ? AND archived_at IS NULL').get(input.seriesId)
    if (!series) throw new Error('Series không tồn tại hoặc đã được lưu trữ.')
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO books(id, series_id, title, genre, status, target_chapters, approved_chapters, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, input.seriesId, input.title, input.genre, input.status, input.targetChapters, now, now)
      this.db.prepare(`
        INSERT INTO brief_versions(id, book_id, version, data_json, status, created_at)
        VALUES(?, ?, 1, ?, 'draft', ?)
      `).run(randomUUID(), id, JSON.stringify(StoryBriefSchema.parse({ targetChapters: input.targetChapters })), now)
      this.db.prepare('UPDATE series SET updated_at = ? WHERE id = ?').run(now, input.seriesId)
      this.setSetting('active_book_id', id)
      this.writeAudit('book.created', id, input)
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateBook(input: UpdateBookInput): void {
    const series = this.db.prepare('SELECT id FROM series WHERE id = ? AND archived_at IS NULL').get(input.seriesId)
    if (!series) throw new Error('Series đích không tồn tại hoặc đã được lưu trữ.')
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE books SET series_id = ?, title = ?, genre = ?, status = ?, target_chapters = ?, updated_at = ?
      WHERE id = ? AND archived_at IS NULL
    `).run(input.seriesId, input.title, input.genre, input.status, input.targetChapters, now, input.id)
    if (Number(result.changes) === 0) throw new Error('Không tìm thấy sách để cập nhật.')
    this.db.prepare('UPDATE series SET updated_at = ? WHERE id = ?').run(now, input.seriesId)
    this.writeAudit('book.updated', input.id, input)
  }

  archiveBook(id: string): void {
    const book = this.db.prepare('SELECT id, series_id FROM books WHERE id = ? AND archived_at IS NULL').get(id) as SqlRow | undefined
    if (!book) throw new Error('Sách không tồn tại hoặc đã được lưu trữ.')
    const fallback = this.db.prepare(`
      SELECT b.id FROM books b JOIN series s ON s.id = b.series_id
      WHERE b.id <> ? AND b.archived_at IS NULL AND s.archived_at IS NULL
      ORDER BY b.updated_at DESC LIMIT 1
    `).get(id) as SqlRow | undefined
    if (!fallback) throw new Error('Cần ít nhất một sách hoạt động trước khi lưu trữ sách này.')
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE chapters SET archived_at = ?, updated_at = ? WHERE book_id = ? AND archived_at IS NULL').run(now, now, id)
      this.db.prepare('UPDATE books SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
      this.db.prepare('UPDATE series SET updated_at = ? WHERE id = ?').run(now, String(book.series_id))
      if (this.getActiveBookId() === id) this.setSetting('active_book_id', String(fallback.id))
      this.writeAudit('book.archived', id, { fallbackBookId: String(fallback.id) })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  createChapter(input: CreateChapterInput): string {
    const book = this.db.prepare('SELECT id FROM books WHERE id = ? AND archived_at IS NULL').get(input.bookId)
    if (!book) throw new Error('Sách không tồn tại hoặc đã được lưu trữ.')
    const latest = this.db.prepare(`
      SELECT COALESCE(MAX(number), 0) AS number FROM chapters WHERE book_id = ? AND archived_at IS NULL
    `).get(input.bookId) as SqlRow
    const id = randomUUID()
    const now = new Date().toISOString()
    const number = Number(latest.number) + 1
    this.db.prepare(`
      INSERT INTO chapters(id, book_id, number, title, summary, status, content_json, word_count, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, input.bookId, number, input.title, input.summary, input.status, JSON.stringify(emptyDocument()), now, now)
    this.db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now, input.bookId)
    this.writeAudit('chapter.created', id, { ...input, number })
    this.rebuildChapterSummary(id)
    return id
  }

  updateChapter(input: UpdateChapterInput): void {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE chapters SET title = ?, summary = ?, status = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL
    `).run(input.title, input.summary, input.status, now, input.id)
    if (Number(result.changes) === 0) throw new Error('Không tìm thấy chương để cập nhật.')
    this.db.prepare('UPDATE manuscript_fts SET title = ? WHERE entity_id = ?').run(input.title, input.id)
    this.writeAudit('chapter.updated', input.id, input)
    this.rebuildChapterSummary(input.id)
  }

  archiveChapter(id: string): string {
    const chapter = this.db.prepare('SELECT book_id FROM chapters WHERE id = ? AND archived_at IS NULL').get(id) as SqlRow | undefined
    if (!chapter) throw new Error('Chương không tồn tại hoặc đã được lưu trữ.')
    const summaryRow = this.db.prepare('SELECT id FROM chapter_summaries WHERE chapter_id = ?').get(id) as SqlRow | undefined
    const now = new Date().toISOString()
    this.db.prepare('UPDATE chapters SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id)
    this.db.prepare('DELETE FROM manuscript_fts WHERE entity_id = ?').run(id)
    if (summaryRow) this.db.prepare("DELETE FROM context_fts WHERE entity_type = 'chapter_summary' AND entity_id = ?").run(String(summaryRow.id))
    this.writeAudit('chapter.archived', id, { bookId: String(chapter.book_id) })
    return String(chapter.book_id)
  }

  startWorkflow(chapterId: string, preset: WorkflowPreset, routes: ProviderRoute[] = []): string {
    const chapter = this.db.prepare(`
      SELECT c.*, b.title AS book_title FROM chapters c
      JOIN books b ON b.id = c.book_id
      WHERE c.id = ? AND c.archived_at IS NULL AND b.archived_at IS NULL
    `).get(chapterId) as SqlRow | undefined
    if (!chapter) throw new Error('Không tìm thấy chương để chạy workflow.')
    const bookId = String(chapter.book_id)
    const outline = this.db.prepare(`
      SELECT id, version, data_json FROM outline_versions
      WHERE book_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1
    `).get(bookId) as SqlRow | undefined
    if (!outline) throw new Error('Hãy duyệt một phiên bản dàn ý trước khi chạy workflow.')
    const outlineChapters = parseOutlineChapters(outline.data_json, String(outline.id)).value
    if (!outlineChapters.some((item) => item.number === Number(chapter.number))) {
      throw new Error('Dàn ý đã duyệt chưa có mục tương ứng với chương này, hoặc dữ liệu dàn ý đã hỏng. Hãy duyệt lại một phiên bản dàn ý.')
    }
    const active = this.db.prepare(`
      SELECT id FROM workflow_runs
      WHERE chapter_id = ? AND status IN ('queued', 'running', 'paused', 'waiting_review', 'interrupted', 'billing_unknown')
      ORDER BY created_at DESC LIMIT 1
    `).get(chapterId)
    if (active) throw new Error('Chương này đã có một workflow chưa hoàn tất.')

    const id = randomUUID()
    const now = new Date().toISOString()
    const steps = getWorkflowSteps(preset)
    const routesByRole = new Map(routes.map((route) => [route.roleId, route]))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO workflow_runs(
          id, book_id, chapter_id, outline_version_id, preset, status, detail, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, bookId, chapterId, String(outline.id), preset, 'Đang chờ bắt đầu', now, now)
      const insertStep = this.db.prepare(`
        INSERT INTO workflow_steps(
          id, run_id, ordinal, role_id, artifact_kind, label, status, provider, model,
          input_cost_per_million, output_cost_per_million, context_token_budget, prompt_version, input_fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'p0.4-v1', ?)
      `)
      steps.forEach((step, ordinal) => {
        const route = routesByRole.get(step.roleId) ?? {
          roleId: step.roleId,
          provider: 'demo' as const,
          model: 'deterministic-v1',
          inputCostPerMillion: null,
          outputCostPerMillion: null,
          contextTokenBudget: 16_000
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({
          chapterId,
          outlineVersion: Number(outline.version),
          preset,
          ordinal,
          roleId: step.roleId,
          kind: step.kind,
          provider: route.provider,
          model: route.model,
          contextTokenBudget: route.contextTokenBudget
        })).digest('hex')
        insertStep.run(
          randomUUID(), id, ordinal, step.roleId, step.kind, step.label,
          route.provider, route.model, route.inputCostPerMillion, route.outputCostPerMillion, route.contextTokenBudget, fingerprint
        )
      })
      this.db.prepare(`
        INSERT INTO jobs(
          id, book_id, label, role_id, status, progress, detail, input_tokens, output_tokens, estimated_cost, started_at, updated_at
        ) VALUES(?, ?, ?, ?, 'queued', 0, ?, 0, 0, 0, NULL, ?)
      `).run(id, bookId, `Chương ${chapter.number} · ${chapter.title}`, steps[0]?.roleId ?? 'director', 'Đang chờ bắt đầu', now)
      this.writeWorkflowEvent(id, 'workflow.created', {
        chapterId,
        preset,
        stepCount: steps.length,
        routes: steps.map((step) => {
          const route = routesByRole.get(step.roleId)
          return {
            roleId: step.roleId,
            provider: route?.provider ?? 'demo',
            model: route?.model ?? 'deterministic-v1',
            contextTokenBudget: route?.contextTokenBudget ?? 16_000
          }
        })
      })
      this.writeAudit('workflow.created', id, { bookId, chapterId, preset })
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  interruptActiveWorkflows(): void {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const runs = this.db.prepare(`
        SELECT id FROM workflow_runs WHERE status IN ('queued', 'running')
      `).all() as SqlRow[]
      const uncertainRuns = new Set((this.db.prepare(`
        SELECT DISTINCT run_id FROM workflow_steps
        WHERE status = 'running' AND provider <> 'demo' AND billing_state IN ('unknown', 'confirmed')
      `).all() as SqlRow[]).map((row) => String(row.run_id)))
      this.db.prepare(`
        UPDATE workflow_runs SET status = 'interrupted', detail = 'Ứng dụng đã đóng trước khi workflow hoàn tất', updated_at = ?
        WHERE status IN ('queued', 'running')
      `).run(now)
      for (const runId of uncertainRuns) {
        this.db.prepare(`
          UPDATE workflow_runs SET status = 'billing_unknown', detail = 'Ứng dụng đã đóng sau khi gửi request · chi phí chưa xác định', updated_at = ?
          WHERE id = ?
        `).run(now, runId)
      }
      this.db.prepare(`
        UPDATE workflow_steps SET status = 'interrupted', last_error = 'Workflow bị gián đoạn', completed_at = ?
        WHERE status = 'running'
      `).run(now)
      for (const runId of uncertainRuns) {
        this.db.prepare(`
          UPDATE workflow_steps SET status = 'billing_unknown', billing_state = 'unknown',
            cost_status = 'unknown', last_error = 'Runtime dừng sau khi gửi request', completed_at = ?
          WHERE run_id = ? AND status = 'interrupted'
        `).run(now, runId)
      }
      this.db.prepare(`
        UPDATE workflow_attempts SET status = 'interrupted', error = 'Workflow bị gián đoạn', completed_at = ?
        WHERE status = 'running'
      `).run(now)
      for (const runId of uncertainRuns) {
        this.db.prepare(`
          UPDATE workflow_attempts SET status = 'billing_unknown', billing_state = 'unknown', cost_status = 'unknown',
            error = 'Runtime dừng sau khi gửi request', completed_at = ?
          WHERE step_id IN (SELECT id FROM workflow_steps WHERE run_id = ?) AND status = 'interrupted'
        `).run(now, runId)
      }
      this.db.prepare(`
        UPDATE jobs SET status = 'interrupted', detail = 'Đã gián đoạn · có thể tiếp tục', updated_at = ?
        WHERE id IN (SELECT id FROM workflow_runs WHERE status = 'interrupted')
      `).run(now)
      for (const runId of uncertainRuns) {
        this.db.prepare(`
          UPDATE jobs SET status = 'billing_unknown', detail = 'Chi phí request chưa xác định · cần quyết định thủ công',
            cost_status = 'unknown', updated_at = ? WHERE id = ?
        `).run(now, runId)
      }
      runs.forEach((run) => {
        const runId = String(run.id)
        this.writeWorkflowEvent(runId, uncertainRuns.has(runId) ? 'workflow.billing_unknown' : 'workflow.interrupted', {})
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  claimWorkflowStep(runId: string): WorkflowStepLease | null {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
      if (!run || !['queued', 'running'].includes(String(run.status))) {
        this.db.exec('COMMIT')
        return null
      }
      const runningStep = this.db.prepare(`
        SELECT id FROM workflow_steps WHERE run_id = ? AND status = 'running' LIMIT 1
      `).get(runId)
      if (runningStep) {
        this.db.exec('COMMIT')
        return null
      }
      const step = this.db.prepare(`
        SELECT * FROM workflow_steps WHERE run_id = ? AND status = 'pending' ORDER BY ordinal ASC LIMIT 1
      `).get(runId) as SqlRow | undefined
      if (!step) {
        const failed = this.db.prepare(`
          SELECT 1 AS value FROM workflow_steps WHERE run_id = ? AND status = 'failed' LIMIT 1
        `).get(runId)
        if (!failed) {
          this.db.prepare(`
            UPDATE workflow_runs SET status = 'waiting_review', progress = 94, detail = 'Các đề xuất đang chờ bạn duyệt', updated_at = ? WHERE id = ?
          `).run(now, runId)
          this.db.prepare(`
            UPDATE jobs SET status = 'waiting_review', progress = 94, detail = 'Đang chờ duyệt artifact', updated_at = ? WHERE id = ?
          `).run(now, runId)
          this.writeWorkflowEvent(runId, 'workflow.waiting_review', {})
        }
        this.db.exec('COMMIT')
        return null
      }

      const attempt = Number(step.attempt_count) + 1
      const attemptId = randomUUID()
      const startedAt = run.started_at ? String(run.started_at) : now
      this.db.prepare(`
        UPDATE workflow_runs SET status = 'running', current_step = ?, detail = ?, error = NULL,
          started_at = ?, updated_at = ? WHERE id = ?
      `).run(Number(step.ordinal), String(step.label), startedAt, now, runId)
      this.db.prepare(`
        UPDATE workflow_steps SET status = 'running', attempt_count = ?, last_error = NULL, request_id = NULL,
          http_status = NULL, retry_count = 0, retry_at = NULL, billing_state = 'not_started',
          cost_status = CASE WHEN provider = 'demo' THEN 'not_applicable' ELSE 'unknown' END,
          started_at = ?, completed_at = NULL WHERE id = ?
      `).run(attempt, now, String(step.id))
      this.db.prepare(`
        INSERT INTO workflow_attempts(
          id, step_id, attempt, status, provider, model, billing_state, cost_status, started_at
        ) VALUES(?, ?, ?, 'running', ?, ?, 'not_started', ?, ?)
      `).run(
        attemptId,
        String(step.id),
        attempt,
        String(step.provider),
        String(step.model),
        String(step.provider) === 'demo' ? 'not_applicable' : 'unknown',
        now
      )
      this.db.prepare(`
        UPDATE jobs SET role_id = ?, status = 'preparing', detail = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
      `).run(String(step.role_id), String(step.label), now, now, runId)
      this.writeWorkflowEvent(runId, 'step.started', { stepId: String(step.id), ordinal: Number(step.ordinal), attempt })
      this.db.exec('COMMIT')

      const chapterRow = this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(String(run.chapter_id)) as SqlRow
      const outlineRow = this.db.prepare('SELECT data_json FROM outline_versions WHERE id = ?').get(String(run.outline_version_id)) as SqlRow
      const outline = parseOutlineChapters(outlineRow.data_json, String(run.outline_version_id))
        .value.find((item) => item.number === Number(chapterRow.number))
      if (!outline) throw new Error('Không tìm thấy mục dàn ý đã khóa cho chương, hoặc phiên bản dàn ý đã khóa bị hỏng.')
      const chapter = mapChapter(chapterRow)
      const brief = this.getLatestBrief(String(run.book_id))
      const previousArtifacts = this.listWorkflowArtifacts(runId)
      const contextTokenBudget = Math.max(2_000, Number(step.context_token_budget ?? 16_000))
      const contextCandidates = this.selectLongContextCandidates(String(run.book_id), chapter.number, `${chapter.title} ${chapter.summary} ${outline.title} ${outline.purpose}`)
      const lockedContextArtifact = previousArtifacts.find((artifact) => artifact.kind === 'context_packet')
      const lockedContext = lockedContextArtifact ? LongContextPacketSchema.safeParse({
        query: lockedContextArtifact.data.query,
        sources: lockedContextArtifact.data.sources,
        continuityIssues: lockedContextArtifact.data.continuityIssues,
        budget: lockedContextArtifact.data.budget
      }) : null
      const contextPacket = lockedContext?.success ? rebudgetLongContextPacket(lockedContext.data, contextTokenBudget) : buildLongContextPacket({
        brief,
        outline,
        chapter,
        canon: contextCandidates.canon,
        chapterSummaries: contextCandidates.summaries,
        previousArtifacts,
        tokenBudget: contextTokenBudget
      })
      const selectedCanonIds = new Set(contextPacket.sources.filter((source) => source.kind === 'canon').map((source) => source.id))
      const canon = contextCandidates.canon.filter((fact) => selectedCanonIds.has(fact.id))
      return {
        runId,
        stepId: String(step.id),
        attemptId,
        attempt,
        ordinal: Number(step.ordinal),
        roleId: String(step.role_id),
        kind: String(step.artifact_kind) as WorkflowArtifactKind,
        label: String(step.label),
        provider: String(step.provider) as ProviderKind,
        model: String(step.model),
        inputCostPerMillion: step.input_cost_per_million === null ? null : Number(step.input_cost_per_million),
        outputCostPerMillion: step.output_cost_per_million === null ? null : Number(step.output_cost_per_million),
        contextTokenBudget,
        chapter,
        brief,
        outline,
        canon,
        previousArtifacts,
        contextPacket
      }
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  recordWorkflowProviderEvent(lease: WorkflowStepLease, event: ProviderRequestEvent): void {
    const active = this.db.prepare(`
      SELECT 1 AS value FROM workflow_steps s JOIN workflow_runs r ON r.id = s.run_id
      WHERE s.id = ? AND s.status = 'running' AND r.status = 'running'
    `).get(lease.stepId)
    if (!active) return
    const now = new Date().toISOString()
    const jobStatus = event.type === 'response' ? 'validating' : 'submitting'
    const detail = event.type === 'retry_scheduled'
      ? `Provider giới hạn tốc độ · thử lại lúc ${event.retryAt ?? 'sớm nhất có thể'}`
      : event.type === 'response' ? 'Đã nhận phản hồi · đang xác thực artifact' : 'Đã gửi request tới provider'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE workflow_steps SET request_id = ?, http_status = ?, retry_count = ?, retry_at = ?, billing_state = ?
        WHERE id = ? AND status = 'running'
      `).run(event.requestId, event.httpStatus, event.retryCount, event.retryAt, event.billingState, lease.stepId)
      this.db.prepare(`
        UPDATE workflow_attempts SET request_id = ?, http_status = ?, retry_count = ?, retry_at = ?, billing_state = ?
        WHERE id = ? AND status = 'running'
      `).run(event.requestId, event.httpStatus, event.retryCount, event.retryAt, event.billingState, lease.attemptId)
      this.db.prepare(`UPDATE jobs SET status = ?, detail = ?, updated_at = ? WHERE id = ?`).run(jobStatus, detail, now, lease.runId)
      this.writeWorkflowEvent(lease.runId, `provider.${event.type}`, {
        stepId: lease.stepId,
        requestId: event.requestId,
        httpStatus: event.httpStatus,
        retryCount: event.retryCount,
        retryAt: event.retryAt,
        billingState: event.billingState
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  completeWorkflowStep(lease: WorkflowStepLease, draft: WorkflowArtifactDraft): boolean {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(lease.runId) as SqlRow | undefined
      const step = this.db.prepare('SELECT status FROM workflow_steps WHERE id = ?').get(lease.stepId) as SqlRow | undefined
      if (!run || String(run.status) !== 'running' || !step || String(step.status) !== 'running') {
        this.db.prepare(`
          UPDATE workflow_attempts SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE 'interrupted' END,
            error = 'Kết quả đến sau khi workflow đã dừng',
            request_id = ?, http_status = ?, retry_count = ?, billing_state = 'confirmed', cost_status = ?, completed_at = ?
          WHERE id = ?
        `).run(draft.requestId, draft.httpStatus, draft.retryCount, draft.costStatus, now, lease.attemptId)
        this.db.prepare(`
          INSERT INTO usage_ledger(
            id, run_id, step_id, attempt_id, provider, model, request_id,
            input_tokens, output_tokens, estimated_cost, cost_status, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), lease.runId, lease.stepId, lease.attemptId, draft.provider, draft.model, draft.requestId,
          draft.inputTokens, draft.outputTokens, draft.estimatedCost, draft.costStatus, now
        )
        this.db.prepare(`
          UPDATE jobs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, estimated_cost = estimated_cost + ?,
            cost_status = CASE
              WHEN cost_status = 'unknown' OR ? = 'unknown' THEN 'unknown'
              WHEN cost_status = 'estimated' OR ? = 'estimated' THEN 'estimated'
              ELSE 'not_applicable'
            END,
            updated_at = ? WHERE id = ?
        `).run(
          draft.inputTokens, draft.outputTokens, draft.estimatedCost,
          draft.costStatus, draft.costStatus, now, lease.runId
        )
        if (run && String(run.status) === 'billing_unknown') {
          this.db.prepare(`
            UPDATE workflow_steps SET status = 'failed', billing_state = 'confirmed', cost_status = ?,
              request_id = ?, http_status = ?, retry_count = ?, retry_at = NULL,
              last_error = 'Phản hồi đến sau khi workflow đã dừng; artifact không được lưu', completed_at = ? WHERE id = ?
          `).run(draft.costStatus, draft.requestId, draft.httpStatus, draft.retryCount, now, lease.stepId)
          this.db.prepare(`
            UPDATE workflow_runs SET status = 'failed', detail = 'Provider đã tính usage nhưng artifact đến sau khi dừng',
              error = 'late_provider_response', updated_at = ? WHERE id = ?
          `).run(now, lease.runId)
          this.db.prepare(`
            UPDATE jobs SET status = 'failed', detail = 'Phản hồi đến muộn · artifact không được lưu', updated_at = ? WHERE id = ?
          `).run(now, lease.runId)
        }
        this.writeWorkflowEvent(lease.runId, 'provider.late_response', {
          stepId: lease.stepId,
          requestId: draft.requestId,
          inputTokens: draft.inputTokens,
          outputTokens: draft.outputTokens,
          costStatus: draft.costStatus
        })
        this.db.exec('COMMIT')
        return false
      }
      const artifactId = randomUUID()
      this.db.prepare(`
        INSERT INTO workflow_artifacts(
          id, run_id, step_id, chapter_id, kind, role_id, status, title, summary, data_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, 'proposal', ?, ?, ?, ?)
      `).run(artifactId, lease.runId, lease.stepId, lease.chapter.id, lease.kind, lease.roleId, draft.title, draft.summary, JSON.stringify(draft.data), now)
      this.db.prepare(`
        UPDATE workflow_attempts SET status = 'completed', output_json = ?, request_id = ?, http_status = ?,
          retry_count = ?, retry_at = NULL, billing_state = 'confirmed', cost_status = ?, completed_at = ? WHERE id = ?
      `).run(JSON.stringify({ artifactId, kind: lease.kind }), draft.requestId, draft.httpStatus, draft.retryCount, draft.costStatus, now, lease.attemptId)
      this.db.prepare(`
        UPDATE workflow_steps SET status = 'completed', provider = ?, model = ?, request_id = ?, http_status = ?,
          retry_count = ?, retry_at = NULL, billing_state = 'confirmed', cost_status = ?, completed_at = ? WHERE id = ?
      `).run(draft.provider, draft.model, draft.requestId, draft.httpStatus, draft.retryCount, draft.costStatus, now, lease.stepId)
      this.db.prepare(`
        INSERT INTO usage_ledger(
          id, run_id, step_id, attempt_id, provider, model, request_id,
          input_tokens, output_tokens, estimated_cost, cost_status, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), lease.runId, lease.stepId, lease.attemptId, draft.provider, draft.model, draft.requestId,
        draft.inputTokens, draft.outputTokens, draft.estimatedCost, draft.costStatus, now
      )

      const counts = this.db.prepare(`
        SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
        FROM workflow_steps WHERE run_id = ?
      `).get(lease.runId) as SqlRow
      const progress = Math.round((Number(counts.completed) / Math.max(1, Number(counts.total))) * 90)
      const next = this.db.prepare(`
        SELECT role_id, label, ordinal FROM workflow_steps WHERE run_id = ? AND status = 'pending' ORDER BY ordinal ASC LIMIT 1
      `).get(lease.runId) as SqlRow | undefined
      const status = next ? 'running' : 'waiting_review'
      const detail = next ? `Tiếp theo · ${String(next.label)}` : 'Các đề xuất đang chờ bạn duyệt'
      const finalProgress = next ? progress : 94
      this.db.prepare(`
        UPDATE workflow_runs SET status = ?, current_step = ?, progress = ?, detail = ?, updated_at = ? WHERE id = ?
      `).run(status, next ? Number(next.ordinal) : Number(counts.total), finalProgress, detail, now, lease.runId)
      this.db.prepare(`
        UPDATE jobs SET role_id = ?, status = ?, progress = ?, detail = ?,
          input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, estimated_cost = estimated_cost + ?,
          cost_status = CASE
            WHEN cost_status = 'unknown' OR ? = 'unknown' THEN 'unknown'
            WHEN cost_status = 'estimated' OR ? = 'estimated' THEN 'estimated'
            ELSE 'not_applicable'
          END,
          updated_at = ? WHERE id = ?
      `).run(
        next ? String(next.role_id) : lease.roleId,
        next ? 'preparing' : 'waiting_review',
        finalProgress,
        detail,
        draft.inputTokens,
        draft.outputTokens,
        draft.estimatedCost,
        draft.costStatus,
        draft.costStatus,
        now,
        lease.runId
      )
      this.writeWorkflowEvent(lease.runId, 'step.completed', { stepId: lease.stepId, artifactId, kind: lease.kind })
      if (!next) this.writeWorkflowEvent(lease.runId, 'workflow.waiting_review', {})
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  failWorkflowStep(lease: WorkflowStepLease, error: string, metadata?: WorkflowFailureMetadata): void {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(lease.runId) as SqlRow | undefined
      const billingState = metadata?.billingState ?? 'not_billed'
      const uncertain = billingState === 'unknown'
      const failureStatus = uncertain ? 'billing_unknown' : 'failed'
      const persistedAttemptStatus = !run || String(run.status) === 'running'
        ? failureStatus
        : String(run.status) === 'cancelled' ? 'cancelled'
          : String(run.status) === 'billing_unknown' ? 'billing_unknown' : 'interrupted'
      const costStatus = metadata?.costStatus ?? (billingState === 'not_billed' || lease.provider === 'demo' ? 'not_applicable' : 'unknown')
      const hasUsage = typeof metadata?.inputTokens === 'number' && typeof metadata.outputTokens === 'number'
      this.db.prepare(`
        UPDATE workflow_attempts SET status = ?, error = ?, request_id = COALESCE(?, request_id),
          http_status = COALESCE(?, http_status), retry_count = ?, retry_at = ?, billing_state = ?, cost_status = ?, completed_at = ?
        WHERE id = ?
      `).run(
        persistedAttemptStatus, error, metadata?.requestId ?? null, metadata?.httpStatus ?? null,
        metadata?.retryCount ?? 0, metadata?.retryAt ?? null, billingState, costStatus, now, lease.attemptId
      )
      if (hasUsage) {
        this.db.prepare(`
          INSERT INTO usage_ledger(
            id, run_id, step_id, attempt_id, provider, model, request_id,
            input_tokens, output_tokens, estimated_cost, cost_status, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), lease.runId, lease.stepId, lease.attemptId,
          metadata?.provider ?? lease.provider, metadata?.model ?? lease.model, metadata?.requestId ?? null,
          metadata?.inputTokens ?? 0, metadata?.outputTokens ?? 0, metadata?.estimatedCost ?? 0, costStatus, now
        )
      }
      if (run && String(run.status) === 'running') {
        this.db.prepare(`
          UPDATE workflow_steps SET status = ?, last_error = ?, request_id = COALESCE(?, request_id),
            http_status = COALESCE(?, http_status), retry_count = ?, retry_at = ?, billing_state = ?, cost_status = ?, completed_at = ?
          WHERE id = ?
        `).run(
          failureStatus, error, metadata?.requestId ?? null, metadata?.httpStatus ?? null,
          metadata?.retryCount ?? 0, metadata?.retryAt ?? null, billingState, costStatus, now, lease.stepId
        )
        const detail = uncertain ? 'Chi phí request chưa xác định · cần quyết định thủ công' : 'Workflow cần được thử lại'
        this.db.prepare(`UPDATE workflow_runs SET status = ?, detail = ?, error = ?, updated_at = ? WHERE id = ?`).run(failureStatus, detail, error, now, lease.runId)
        this.db.prepare(`
          UPDATE jobs SET status = ?, detail = ?,
            input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, estimated_cost = estimated_cost + ?,
            cost_status = CASE
              WHEN cost_status = 'unknown' OR ? = 'unknown' THEN 'unknown'
              WHEN cost_status = 'estimated' OR ? = 'estimated' THEN 'estimated'
              ELSE 'not_applicable'
            END,
            updated_at = ? WHERE id = ?
        `).run(
          failureStatus, detail,
          hasUsage ? metadata?.inputTokens ?? 0 : 0,
          hasUsage ? metadata?.outputTokens ?? 0 : 0,
          hasUsage ? metadata?.estimatedCost ?? 0 : 0,
          costStatus,
          costStatus,
          now,
          lease.runId
        )
      } else {
        this.db.prepare(`
          UPDATE workflow_steps SET last_error = ?, request_id = COALESCE(?, request_id), http_status = COALESCE(?, http_status),
            retry_count = ?, retry_at = ?, billing_state = ?, cost_status = ? WHERE id = ?
        `).run(
          error, metadata?.requestId ?? null, metadata?.httpStatus ?? null,
          metadata?.retryCount ?? 0, metadata?.retryAt ?? null, billingState, costStatus, lease.stepId
        )
      }
      this.writeWorkflowEvent(lease.runId, uncertain ? 'step.billing_unknown' : 'step.failed', {
        stepId: lease.stepId,
        error,
        requestId: metadata?.requestId ?? null,
        httpStatus: metadata?.httpStatus ?? null,
        retryCount: metadata?.retryCount ?? 0,
        billingState
      })
      this.db.exec('COMMIT')
    } catch (cause) {
      this.db.exec('ROLLBACK')
      throw cause
    }
  }

  failWorkflowRun(runId: string, error: string): void {
    const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
    if (!run || !['queued', 'running'].includes(String(run.status))) return
    const step = this.db.prepare(`
      SELECT id FROM workflow_steps
      WHERE run_id = ? AND status IN ('running', 'pending')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, ordinal ASC LIMIT 1
    `).get(runId) as SqlRow | undefined
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (step) {
        this.db.prepare(`
          UPDATE workflow_attempts SET status = 'failed', error = ?, completed_at = ?
          WHERE step_id = ? AND status = 'running'
        `).run(error, now, String(step.id))
        this.db.prepare(`
          UPDATE workflow_steps SET status = 'failed', last_error = ?, completed_at = ? WHERE id = ?
        `).run(error, now, String(step.id))
      }
      this.db.prepare(`
        UPDATE workflow_runs SET status = 'failed', detail = 'Workflow cần được thử lại', error = ?, updated_at = ? WHERE id = ?
      `).run(error, now, runId)
      this.db.prepare(`UPDATE jobs SET status = 'failed', detail = ?, updated_at = ? WHERE id = ?`).run(error, now, runId)
      this.writeWorkflowEvent(runId, 'workflow.failed', { stepId: step ? String(step.id) : null, error })
      this.db.exec('COMMIT')
    } catch (cause) {
      this.db.exec('ROLLBACK')
      throw cause
    }
  }

  pauseWorkflow(runId: string): void {
    const uncertain = this.db.prepare(`
      SELECT 1 AS value FROM workflow_steps
      WHERE run_id = ? AND status = 'running' AND provider <> 'demo' AND billing_state IN ('unknown', 'confirmed') LIMIT 1
    `).get(runId)
    if (uncertain) {
      this.changeWorkflowLifecycle(runId, ['running'], 'billing_unknown', 'Đã dừng sau khi gửi request · chi phí chưa xác định')
      return
    }
    this.changeWorkflowLifecycle(runId, ['queued', 'running'], 'paused', 'Đã tạm dừng · có thể tiếp tục')
  }

  resumeWorkflow(runId: string): void {
    const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
    if (!run || !['paused', 'interrupted'].includes(String(run.status))) throw new Error('Workflow này không ở trạng thái có thể tiếp tục.')
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE workflow_steps SET status = 'pending', last_error = NULL, request_id = NULL, http_status = NULL,
          retry_count = 0, retry_at = NULL, billing_state = 'not_started',
          cost_status = CASE WHEN provider = 'demo' THEN 'not_applicable' ELSE 'unknown' END,
          started_at = NULL, completed_at = NULL
        WHERE run_id = ? AND status = 'interrupted'
      `).run(runId)
      this.db.prepare(`UPDATE workflow_runs SET status = 'queued', detail = 'Đang chờ tiếp tục', error = NULL, updated_at = ? WHERE id = ?`).run(now, runId)
      this.db.prepare(`UPDATE jobs SET status = 'queued', detail = 'Đang chờ tiếp tục', updated_at = ? WHERE id = ?`).run(now, runId)
      this.writeWorkflowEvent(runId, 'workflow.resumed', {})
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  retryWorkflow(runId: string): void {
    const run = this.db.prepare('SELECT status, error FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
    if (!run || !['failed', 'billing_unknown'].includes(String(run.status))) throw new Error('Workflow này không ở trạng thái có thể thử lại.')
    const failedStep = this.db.prepare(`SELECT id FROM workflow_steps WHERE run_id = ? AND status IN ('failed', 'billing_unknown') LIMIT 1`).get(runId)
    if (!failedStep) throw new Error('Workflow đã bị từ chối; hãy tạo một workflow mới để giữ nguyên lịch sử.')
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE workflow_steps SET status = 'pending', last_error = NULL, request_id = NULL, http_status = NULL,
          retry_count = 0, retry_at = NULL, billing_state = 'not_started',
          cost_status = CASE WHEN provider = 'demo' THEN 'not_applicable' ELSE 'unknown' END,
          started_at = NULL, completed_at = NULL
        WHERE run_id = ? AND status IN ('failed', 'billing_unknown')
      `).run(runId)
      this.db.prepare(`UPDATE workflow_runs SET status = 'queued', detail = 'Đang chờ thử lại', error = NULL, updated_at = ? WHERE id = ?`).run(now, runId)
      this.db.prepare(`UPDATE jobs SET status = 'queued', detail = 'Đang chờ thử lại', updated_at = ? WHERE id = ?`).run(now, runId)
      this.writeWorkflowEvent(runId, 'workflow.retried', { previousStatus: String(run.status) })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  cancelWorkflow(runId: string): void {
    this.changeWorkflowLifecycle(
      runId,
      ['queued', 'running', 'paused', 'waiting_review', 'interrupted', 'billing_unknown'],
      'cancelled',
      'Đã hủy theo yêu cầu'
    )
  }

  reviewWorkflow(runId: string, decision: 'approve' | 'reject'): string {
    const run = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
    if (!run || String(run.status) !== 'waiting_review') throw new Error('Workflow không còn ở trạng thái chờ duyệt.')
    const artifacts = this.listWorkflowArtifacts(runId)
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (decision === 'reject') {
        this.db.prepare(`UPDATE workflow_artifacts SET status = 'rejected', reviewed_at = ? WHERE run_id = ? AND status = 'proposal'`).run(now, runId)
        this.db.prepare(`UPDATE workflow_runs SET status = 'failed', detail = 'Đề xuất đã bị từ chối', error = 'review_rejected', updated_at = ? WHERE id = ?`).run(now, runId)
        this.db.prepare(`UPDATE jobs SET status = 'failed', progress = 94, detail = 'Đề xuất đã bị từ chối', updated_at = ? WHERE id = ?`).run(now, runId)
        this.writeWorkflowEvent(runId, 'workflow.rejected', {})
        this.writeAudit('workflow.rejected', runId, { chapterId: String(run.chapter_id) })
        this.db.exec('COMMIT')
        return String(run.book_id)
      }

      const finalDraft = [...artifacts].reverse().find((artifact) => artifact.kind === 'revised_draft')
        ?? [...artifacts].reverse().find((artifact) => artifact.kind === 'draft')
      if (!finalDraft) throw new Error('Workflow chưa tạo được bản thảo để commit.')
      const document = finalDraft.data.document
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Artifact bản thảo không đúng schema.')
      const wordCount = Number(finalDraft.data.wordCount ?? 0)
      this.db.prepare(`
        UPDATE chapters SET content_json = ?, word_count = ?, status = 'approved', updated_at = ? WHERE id = ?
      `).run(JSON.stringify(document), wordCount, now, String(run.chapter_id))
      const latestDocument = this.db.prepare(`
        SELECT COALESCE(MAX(version), 0) AS version FROM document_versions WHERE chapter_id = ?
      `).get(String(run.chapter_id)) as SqlRow
      this.db.prepare(`
        INSERT INTO document_versions(id, chapter_id, version, content_json, origin, created_at) VALUES(?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), String(run.chapter_id), Number(latestDocument.version) + 1, JSON.stringify(document), `workflow:${runId}`, now)
      const chapterRow = this.db.prepare('SELECT title FROM chapters WHERE id = ?').get(String(run.chapter_id)) as SqlRow
      this.db.prepare('DELETE FROM manuscript_fts WHERE entity_id = ?').run(String(run.chapter_id))
      this.db.prepare('INSERT INTO manuscript_fts(entity_id, book_id, title, body) VALUES(?, ?, ?, ?)').run(
        String(run.chapter_id),
        String(run.book_id),
        String(chapterRow.title),
        extractText(document)
      )

      const canonDelta = [...artifacts].reverse().find((artifact) => artifact.kind === 'canon_delta')
      const facts = Array.isArray(canonDelta?.data.facts) ? canonDelta.data.facts : []
      for (const candidate of facts) {
        if (!candidate || typeof candidate !== 'object') continue
        const fact = candidate as Record<string, unknown>
        const subject = String(fact.subject ?? '').trim()
        const value = String(fact.fact ?? '').trim()
        if (!subject || !value) continue
        const exists = this.db.prepare(`
          SELECT 1 AS value FROM canon_facts WHERE book_id = ? AND subject = ? AND fact = ? LIMIT 1
        `).get(String(run.book_id), subject, value)
        if (!exists) {
          const canonId = randomUUID()
          this.db.prepare(`
            INSERT INTO canon_facts(id, book_id, category, subject, fact, source_chapter, confidence, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            canonId,
            String(run.book_id),
            normalizeCanonCategory(String(fact.category ?? 'event')),
            subject,
            value,
            Number(fact.sourceChapter ?? 0) || null,
            Math.max(0, Math.min(1, Number(fact.confidence ?? 0.8))),
            now
          )
          this.indexCanonRow({ id: canonId, book_id: String(run.book_id), subject, fact: value })
        }
      }

      this.rebuildChapterSummary(String(run.chapter_id), canonDelta ? {
        summary: String(canonDelta.data.chapterSummary ?? ''),
        keyEvents: Array.isArray(canonDelta.data.keyEvents) ? canonDelta.data.keyEvents.map(String) : [],
        unresolvedThreads: Array.isArray(canonDelta.data.unresolvedThreads) ? canonDelta.data.unresolvedThreads.map(String) : []
      } : undefined)

      const canonArtifactId = canonDelta?.id ?? ''
      this.db.prepare(`
        UPDATE workflow_artifacts SET status = CASE WHEN id IN (?, ?) THEN 'committed' ELSE 'approved' END,
          reviewed_at = ?, committed_at = CASE WHEN id IN (?, ?) THEN ? ELSE committed_at END
        WHERE run_id = ? AND status = 'proposal'
      `).run(finalDraft.id, canonArtifactId, now, finalDraft.id, canonArtifactId, now, runId)
      this.db.prepare(`
        UPDATE workflow_runs SET status = 'completed', progress = 100, detail = 'Đã duyệt và commit an toàn', error = NULL,
          updated_at = ?, completed_at = ? WHERE id = ?
      `).run(now, now, runId)
      this.db.prepare(`
        UPDATE jobs SET status = 'completed', progress = 100, detail = 'Đã duyệt và commit an toàn', updated_at = ? WHERE id = ?
      `).run(now, runId)
      this.db.prepare(`
        UPDATE books SET approved_chapters = (
          SELECT COUNT(*) FROM chapters WHERE book_id = ? AND archived_at IS NULL AND status = 'approved'
        ), status = 'writing', updated_at = ? WHERE id = ?
      `).run(String(run.book_id), now, String(run.book_id))
      this.writeWorkflowEvent(runId, 'workflow.approved', { artifactId: finalDraft.id, canonFacts: facts.length })
      this.writeAudit('workflow.approved', runId, { chapterId: String(run.chapter_id), artifactId: finalDraft.id })
      this.db.exec('COMMIT')
      return String(run.book_id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listWorkflowRuns(bookId: string): WorkflowRun[] {
    const rows = this.db.prepare(`
      SELECT r.*, c.number AS chapter_number, c.title AS chapter_title,
        COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(u.estimated_cost), 0) AS estimated_cost,
        CASE
          WHEN EXISTS(SELECT 1 FROM workflow_steps s WHERE s.run_id = r.id AND s.cost_status = 'unknown') THEN 'unknown'
          WHEN EXISTS(SELECT 1 FROM usage_ledger x WHERE x.run_id = r.id AND x.cost_status = 'estimated') THEN 'estimated'
          ELSE 'not_applicable'
        END AS cost_status
      FROM workflow_runs r
      JOIN chapters c ON c.id = r.chapter_id
      LEFT JOIN usage_ledger u ON u.run_id = r.id
      WHERE r.book_id = ?
      GROUP BY r.id
      ORDER BY r.created_at DESC LIMIT 20
    `).all(bookId) as SqlRow[]
    return rows.map((row) => ({
      id: String(row.id),
      bookId: String(row.book_id),
      chapterId: String(row.chapter_id),
      chapterNumber: Number(row.chapter_number),
      chapterTitle: String(row.chapter_title),
      preset: String(row.preset) as WorkflowPreset,
      status: String(row.status) as WorkflowRunStatus,
      currentStep: Number(row.current_step),
      progress: Number(row.progress),
      detail: String(row.detail),
      error: row.error === null ? null : String(row.error),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      estimatedCost: Number(row.estimated_cost),
      costStatus: String(row.cost_status) as CostStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
      steps: this.listWorkflowSteps(String(row.id)),
      artifacts: this.listWorkflowArtifacts(String(row.id))
    }))
  }

  listReviewArtifacts(bookId: string): WorkflowArtifact[] {
    return (this.db.prepare(`
      SELECT a.* FROM workflow_artifacts a
      JOIN workflow_runs r ON r.id = a.run_id
      WHERE r.book_id = ? AND r.status = 'waiting_review' AND a.status = 'proposal'
      ORDER BY a.created_at ASC
    `).all(bookId) as SqlRow[]).map(mapWorkflowArtifact)
  }

  getWorkflowRunStatus(runId: string): WorkflowRunStatus | null {
    const row = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
    return row ? String(row.status) as WorkflowRunStatus : null
  }

  getWorkflowRoutes(runId: string): ProviderRoute[] {
    return (this.db.prepare(`
      SELECT role_id, provider, model, input_cost_per_million, output_cost_per_million, context_token_budget
      FROM workflow_steps WHERE run_id = ?
      GROUP BY role_id, provider, model, input_cost_per_million, output_cost_per_million, context_token_budget
      ORDER BY MIN(ordinal) ASC
    `).all(runId) as SqlRow[]).map((row) => ({
      roleId: String(row.role_id),
      provider: String(row.provider) as ProviderKind,
      model: String(row.model),
      inputCostPerMillion: row.input_cost_per_million === null ? null : Number(row.input_cost_per_million),
      outputCostPerMillion: row.output_cost_per_million === null ? null : Number(row.output_cost_per_million),
      contextTokenBudget: Math.max(2_000, Number(row.context_token_budget ?? 16_000))
    }))
  }

  private listWorkflowSteps(runId: string): WorkflowStep[] {
    return (this.db.prepare(`SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY ordinal ASC`).all(runId) as SqlRow[]).map(mapWorkflowStep)
  }

  private listWorkflowArtifacts(runId: string): WorkflowArtifact[] {
    return (this.db.prepare(`
      SELECT a.* FROM workflow_artifacts a
      JOIN workflow_steps s ON s.id = a.step_id
      WHERE a.run_id = ? ORDER BY s.ordinal ASC
    `).all(runId) as SqlRow[]).map(mapWorkflowArtifact)
  }

  private changeWorkflowLifecycle(runId: string, allowed: WorkflowRunStatus[], status: WorkflowRunStatus, detail: string): void {
    const run = this.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as SqlRow | undefined
    if (!run || !allowed.includes(String(run.status) as WorkflowRunStatus)) throw new Error('Workflow không ở trạng thái phù hợp với thao tác này.')
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (status === 'paused') {
        this.db.prepare(`UPDATE workflow_steps SET status = 'interrupted', last_error = 'Đã tạm dừng', completed_at = ? WHERE run_id = ? AND status = 'running'`).run(now, runId)
        this.db.prepare(`UPDATE workflow_attempts SET status = 'interrupted', error = 'Đã tạm dừng', completed_at = ? WHERE status = 'running' AND step_id IN (SELECT id FROM workflow_steps WHERE run_id = ?)`).run(now, runId)
      }
      if (status === 'billing_unknown') {
        this.db.prepare(`
          UPDATE workflow_steps SET status = 'billing_unknown', billing_state = 'unknown', cost_status = 'unknown',
            last_error = 'Đã dừng sau khi gửi request', completed_at = ? WHERE run_id = ? AND status = 'running'
        `).run(now, runId)
        this.db.prepare(`
          UPDATE workflow_attempts SET status = 'billing_unknown', billing_state = 'unknown', cost_status = 'unknown',
            error = 'Đã dừng sau khi gửi request', completed_at = ?
          WHERE status = 'running' AND step_id IN (SELECT id FROM workflow_steps WHERE run_id = ?)
        `).run(now, runId)
      }
      if (status === 'cancelled') {
        this.db.prepare(`UPDATE workflow_steps SET status = 'cancelled', completed_at = ? WHERE run_id = ? AND status IN ('pending', 'running', 'interrupted')`).run(now, runId)
        this.db.prepare(`UPDATE workflow_attempts SET status = 'cancelled', error = 'Đã hủy', completed_at = ? WHERE status = 'running' AND step_id IN (SELECT id FROM workflow_steps WHERE run_id = ?)`).run(now, runId)
      }
      this.db.prepare(`UPDATE workflow_runs SET status = ?, detail = ?, updated_at = ?, completed_at = CASE WHEN ? = 'cancelled' THEN ? ELSE completed_at END WHERE id = ?`).run(status, detail, now, status, now, runId)
      const jobStatus = status === 'paused' ? 'paused' : status
      this.db.prepare(`
        UPDATE jobs SET status = ?, detail = ?, cost_status = CASE WHEN ? = 'billing_unknown' THEN 'unknown' ELSE cost_status END, updated_at = ? WHERE id = ?
      `).run(jobStatus, detail, status, now, runId)
      this.writeWorkflowEvent(runId, `workflow.${status}`, {})
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private writeWorkflowEvent(runId: string, eventType: string, data: unknown): void {
    const latest = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workflow_events WHERE run_id = ?`).get(runId) as SqlRow
    this.db.prepare(`
      INSERT INTO workflow_events(id, run_id, sequence, event_type, data_json, created_at) VALUES(?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), runId, Number(latest.sequence) + 1, eventType, JSON.stringify(data), new Date().toISOString())
  }

  listChapterSummaries(bookId: string, limit = 100): ChapterSummary[] {
    return (this.db.prepare(`
      SELECT * FROM chapter_summaries WHERE book_id = ? ORDER BY chapter_number DESC LIMIT ?
    `).all(bookId, Math.max(1, Math.min(5_000, Math.trunc(limit)))) as SqlRow[]).map(mapChapterSummary)
  }

  previewLongContext(chapterId: string, tokenBudget = 16_000): LongContextPacket {
    const chapterRow = this.db.prepare('SELECT * FROM chapters WHERE id = ? AND archived_at IS NULL').get(chapterId) as SqlRow | undefined
    if (!chapterRow) throw new Error('Không tìm thấy chương để xem trước context.')
    const chapter = mapChapter(chapterRow)
    const outlineRow = this.db.prepare(`
      SELECT data_json FROM outline_versions WHERE book_id = ? AND status = 'approved' ORDER BY version DESC LIMIT 1
    `).get(chapter.bookId) as SqlRow | undefined
    if (!outlineRow) throw new Error('Hãy duyệt dàn ý trước khi xem trước context.')
    const outline = parseOutlineChapters(outlineRow.data_json, chapter.bookId)
      .value.find((item) => item.number === chapter.number)
    if (!outline) throw new Error('Dàn ý đã duyệt chưa có chương tương ứng, hoặc dữ liệu dàn ý đã hỏng.')
    const candidates = this.selectLongContextCandidates(chapter.bookId, chapter.number, `${chapter.title} ${chapter.summary} ${outline.title} ${outline.purpose}`)
    return buildLongContextPacket({
      brief: this.getLatestBrief(chapter.bookId),
      outline,
      chapter,
      canon: candidates.canon,
      chapterSummaries: candidates.summaries,
      previousArtifacts: [],
      tokenBudget
    })
  }

  private selectLongContextCandidates(bookId: string, chapterNumber: number, query: string): {
    canon: BootstrapSnapshot['canon']
    summaries: ChapterSummary[]
  } {
    const matched = this.searchContextIndex(bookId, query)
    const matchedCanonIds = matched.filter((item) => item.type === 'canon').map((item) => item.id)
    const matchedSummaryIds = matched.filter((item) => item.type === 'chapter_summary').map((item) => item.id)
    const recentCanon = this.db.prepare(`
      SELECT * FROM canon_facts WHERE book_id = ? AND (source_chapter IS NULL OR source_chapter < ?)
      ORDER BY COALESCE(source_chapter, 0) DESC, confidence DESC LIMIT 240
    `).all(bookId, chapterNumber) as SqlRow[]
    const matchedCanon = this.rowsByIds('canon_facts', bookId, matchedCanonIds)
    const futureCanon = this.db.prepare(`
      SELECT * FROM canon_facts WHERE book_id = ? AND source_chapter >= ? ORDER BY source_chapter ASC LIMIT 40
    `).all(bookId, chapterNumber) as SqlRow[]
    const canonRows = uniqueRowsById([...matchedCanon, ...recentCanon, ...futureCanon])
    const recentSummaries = this.db.prepare(`
      SELECT s.* FROM chapter_summaries s JOIN chapters c ON c.id = s.chapter_id
      WHERE s.book_id = ? AND s.chapter_number < ? AND c.status = 'approved' AND c.archived_at IS NULL
      ORDER BY s.chapter_number DESC LIMIT 80
    `).all(bookId, chapterNumber) as SqlRow[]
    const matchedSummaries = this.rowsByIds('chapter_summaries', bookId, matchedSummaryIds)
    return {
      canon: canonRows.map(mapCanonFact),
      summaries: uniqueRowsById([...matchedSummaries, ...recentSummaries]).map(mapChapterSummary)
    }
  }

  private searchContextIndex(bookId: string, query: string): Array<{ type: string; id: string }> {
    const terms = [...new Set(query.match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 16)
    if (terms.length === 0) return []
    const expression = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
    try {
      return (this.db.prepare(`
        SELECT entity_type, entity_id FROM context_fts
        WHERE context_fts MATCH ? AND book_id = ? ORDER BY bm25(context_fts) LIMIT 120
      `).all(expression, bookId) as SqlRow[]).map((row) => ({ type: String(row.entity_type), id: String(row.entity_id) }))
    } catch {
      return []
    }
  }

  private rowsByIds(table: 'canon_facts' | 'chapter_summaries', bookId: string, ids: string[]): SqlRow[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    if (table === 'chapter_summaries') {
      return this.db.prepare(`
        SELECT s.* FROM chapter_summaries s JOIN chapters c ON c.id = s.chapter_id
        WHERE s.book_id = ? AND s.id IN (${placeholders}) AND c.status = 'approved' AND c.archived_at IS NULL
      `).all(bookId, ...ids) as SqlRow[]
    }
    return this.db.prepare(`SELECT * FROM ${table} WHERE book_id = ? AND id IN (${placeholders})`).all(bookId, ...ids) as SqlRow[]
  }

  private synchronizeChapterSummaries(): void {
    const rows = this.db.prepare(`
      SELECT c.id, c.updated_at, s.source_version AS stored_source_version, s.updated_at AS summary_updated_at,
        COALESCE((SELECT MAX(version) FROM document_versions d WHERE d.chapter_id = c.id), 0) AS latest_source_version
      FROM chapters c LEFT JOIN chapter_summaries s ON s.chapter_id = c.id
      WHERE c.archived_at IS NULL
    `).all() as SqlRow[]
    for (const row of rows) {
      const stale = row.summary_updated_at === null || row.summary_updated_at === undefined
        || Number(row.stored_source_version) !== Number(row.latest_source_version)
        || String(row.updated_at) > String(row.summary_updated_at)
      if (stale) this.rebuildChapterSummary(String(row.id))
    }
    const canonRows = this.db.prepare('SELECT * FROM canon_facts ORDER BY created_at ASC').all() as SqlRow[]
    const indexedCanon = this.db.prepare("SELECT COUNT(*) AS count FROM context_fts WHERE entity_type = 'canon'").get() as SqlRow
    if (Number(indexedCanon.count) !== canonRows.length) {
      this.db.prepare("DELETE FROM context_fts WHERE entity_type = 'canon'").run()
      canonRows.forEach((row) => this.indexCanonRow(row))
    }
  }

  private rebuildChapterSummary(chapterId: string, approved?: { summary: string; keyEvents: string[]; unresolvedThreads: string[] }): void {
    const chapterRow = this.db.prepare('SELECT * FROM chapters WHERE id = ? AND archived_at IS NULL').get(chapterId) as SqlRow | undefined
    if (!chapterRow) return
    const chapter = mapChapter(chapterRow)
    const versionRow = this.db.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM document_versions WHERE chapter_id = ?
    `).get(chapterId) as SqlRow
    const existing = this.db.prepare('SELECT id FROM chapter_summaries WHERE chapter_id = ?').get(chapterId) as SqlRow | undefined
    const canon = (this.db.prepare('SELECT * FROM canon_facts WHERE book_id = ?').all(chapter.bookId) as SqlRow[]).map(mapCanonFact)
    const extracted = summarizeChapter({
      chapter,
      sourceVersion: Number(versionRow.version),
      canon,
      id: existing ? String(existing.id) : `summary:${chapterId}`
    })
    const summary = approved?.summary.trim() ? {
      ...extracted,
      summary: approved.summary.trim(),
      keyEvents: [...new Set(approved.keyEvents.map((item) => item.trim()).filter(Boolean))].slice(0, 8),
      unresolvedThreads: [...new Set(approved.unresolvedThreads.map((item) => item.trim()).filter(Boolean))].slice(0, 8),
      tokenEstimate: estimateTokens(JSON.stringify({
        summary: approved.summary.trim(),
        keyEvents: approved.keyEvents,
        characters: extracted.characters,
        locations: extracted.locations,
        unresolvedThreads: approved.unresolvedThreads
      }))
    } : extracted
    this.db.prepare(`
      INSERT INTO chapter_summaries(
        id, chapter_id, book_id, chapter_number, chapter_title, source_version, summary,
        key_events_json, characters_json, locations_json, unresolved_threads_json, token_estimate, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_id) DO UPDATE SET
        chapter_number = excluded.chapter_number, chapter_title = excluded.chapter_title,
        source_version = excluded.source_version, summary = excluded.summary,
        key_events_json = excluded.key_events_json, characters_json = excluded.characters_json,
        locations_json = excluded.locations_json, unresolved_threads_json = excluded.unresolved_threads_json,
        token_estimate = excluded.token_estimate, updated_at = excluded.updated_at
    `).run(
      summary.id, summary.chapterId, summary.bookId, summary.chapterNumber, summary.chapterTitle,
      summary.sourceVersion, summary.summary, JSON.stringify(summary.keyEvents), JSON.stringify(summary.characters),
      JSON.stringify(summary.locations), JSON.stringify(summary.unresolvedThreads), summary.tokenEstimate, summary.updatedAt
    )
    this.db.prepare("DELETE FROM context_fts WHERE entity_type = 'chapter_summary' AND entity_id = ?").run(summary.id)
    this.db.prepare(`
      INSERT INTO context_fts(entity_type, entity_id, book_id, title, body) VALUES('chapter_summary', ?, ?, ?, ?)
    `).run(summary.id, summary.bookId, summary.chapterTitle, `${summary.summary} ${summary.keyEvents.join(' ')} ${summary.characters.join(' ')} ${summary.locations.join(' ')}`)
  }

  private indexCanonRow(row: SqlRow): void {
    const id = String(row.id)
    this.db.prepare("DELETE FROM context_fts WHERE entity_type = 'canon' AND entity_id = ?").run(id)
    this.db.prepare(`
      INSERT INTO context_fts(entity_type, entity_id, book_id, title, body) VALUES('canon', ?, ?, ?, ?)
    `).run(id, String(row.book_id), String(row.subject), `${String(row.subject)} ${String(row.fact)}`)
  }

  getLatestBrief(bookId: string): StoryBrief {
    const row = this.db.prepare(`
      SELECT data_json FROM brief_versions WHERE book_id = ? ORDER BY version DESC LIMIT 1
    `).get(bookId) as SqlRow | undefined
    if (!row) return StoryBriefSchema.parse({})
    const parsed = parseJsonColumn<Record<string, unknown>>(
      row.data_json,
      {},
      { table: 'brief_versions', column: 'data_json', rowId: bookId },
      isPlainObject
    )
    // Brief hỏng quay về mặc định để Đạo diễn vẫn mở được; bản gốc giữ nguyên trong SQLite.
    const result = StoryBriefSchema.safeParse(parsed.value)
    return result.success ? result.data : StoryBriefSchema.parse({})
  }

  saveBrief(bookId: string, brief: StoryBrief, status = 'draft'): StoryBrief {
    const latest = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM brief_versions WHERE book_id = ?').get(bookId) as SqlRow
    const version = Number(latest.version) + 1
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO brief_versions(id, book_id, version, data_json, status, created_at) VALUES(?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), bookId, version, JSON.stringify(brief), status, now)
    this.db.prepare('UPDATE books SET target_chapters = ?, updated_at = ? WHERE id = ?').run(brief.targetChapters, now, bookId)
    return brief
  }

  saveOutline(bookId: string, outline: OutlineChapter[], status = 'proposal'): OutlineChapter[] {
    const version = this.nextOutlineVersion(bookId)
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO outline_versions(id, book_id, version, data_json, status, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(id, bookId, version, JSON.stringify(outline), status, now)
      this.db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now, bookId)
      this.writeAudit('outline.created', id, { bookId, version, status })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return outline
  }

  listOutlineVersions(bookId: string): OutlineVersion[] {
    return (this.db.prepare(`
      SELECT * FROM outline_versions WHERE book_id = ? ORDER BY version DESC
    `).all(bookId) as SqlRow[]).map(mapOutlineVersion)
  }

  approveOutlineVersion(versionId: string): void {
    const version = this.db.prepare(`
      SELECT id, book_id, version FROM outline_versions WHERE id = ?
    `).get(versionId) as SqlRow | undefined
    if (!version) throw new Error('Không tìm thấy phiên bản dàn ý để duyệt.')
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE outline_versions SET status = 'approved', approved_at = ? WHERE id = ?
      `).run(now, versionId)
      this.db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now, String(version.book_id))
      this.writeAudit('outline.approved', versionId, { bookId: String(version.book_id), version: Number(version.version) })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  restoreOutlineVersion(versionId: string): string {
    const source = this.db.prepare(`
      SELECT * FROM outline_versions WHERE id = ?
    `).get(versionId) as SqlRow | undefined
    if (!source) throw new Error('Không tìm thấy phiên bản dàn ý cần khôi phục.')
    const bookId = String(source.book_id)
    const nextVersion = this.nextOutlineVersion(bookId)
    const restoredId = randomUUID()
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO outline_versions(
          id, book_id, version, data_json, status, origin_version, approved_at, created_at
        ) VALUES(?, ?, ?, ?, 'restored', ?, NULL, ?)
      `).run(restoredId, bookId, nextVersion, String(source.data_json), Number(source.version), now)
      this.db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now, bookId)
      this.writeAudit('outline.restored', restoredId, {
        bookId,
        version: nextVersion,
        sourceVersion: Number(source.version),
        sourceId: versionId
      })
      this.db.exec('COMMIT')
      return restoredId
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private nextOutlineVersion(bookId: string): number {
    const latest = this.db.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM outline_versions WHERE book_id = ?
    `).get(bookId) as SqlRow
    return Number(latest.version) + 1
  }

  appendMessage(bookId: string, role: ChatMessage['role'], content: string): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      bookId,
      role,
      content,
      createdAt: new Date().toISOString()
    }
    this.db.prepare('INSERT INTO conversations(id, book_id, role, content, created_at) VALUES(?, ?, ?, ?, ?)').run(
      message.id,
      bookId,
      role,
      content,
      message.createdAt
    )
    return message
  }

  listMessages(bookId: string): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM conversations WHERE book_id = ? ORDER BY created_at ASC').all(bookId) as SqlRow[]).map((row) => ({
      id: String(row.id),
      bookId: String(row.book_id),
      role: String(row.role) as ChatMessage['role'],
      content: String(row.content),
      createdAt: String(row.created_at)
    }))
  }

  saveChapter(chapterId: string, content: Record<string, unknown>, wordCount: number): Chapter {
    // Nếu content_json hiện tại không parse được, renderer đang hiển thị document
    // dự phòng rỗng. Cho autosave ghi lên sẽ xoá vĩnh viễn bản thảo gốc, nên chặn
    // lại và giữ chương ở chế độ chỉ đọc cho tới khi người dùng khôi phục.
    const existing = this.db.prepare('SELECT content_json FROM chapters WHERE id = ? AND archived_at IS NULL').get(chapterId) as SqlRow | undefined
    if (!existing) throw new Error('Không tìm thấy chương để lưu.')
    if (parseJsonColumn<Record<string, unknown>>(
      existing.content_json,
      emptyDocument(),
      { table: 'chapters', column: 'content_json', rowId: chapterId },
      isPlainObject
    ).corrupt) {
      throw new Error('Nội dung chương này đã hỏng và đang ở chế độ chỉ đọc. Hãy khôi phục từ lịch sử phiên bản hoặc bản sao lưu trước khi sửa, để không ghi đè mất bản gốc.')
    }
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        UPDATE chapters SET content_json = ?, word_count = ?, status = 'drafting', updated_at = ?
        WHERE id = ? AND archived_at IS NULL
      `).run(JSON.stringify(content), wordCount, now, chapterId)
      const latest = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM document_versions WHERE chapter_id = ?').get(chapterId) as SqlRow
      this.db.prepare(`
        INSERT INTO document_versions(id, chapter_id, version, content_json, origin, created_at) VALUES(?, ?, ?, ?, 'autosave', ?)
      `).run(randomUUID(), chapterId, Number(latest.version) + 1, JSON.stringify(content), now)
      const row = this.db.prepare('SELECT book_id, title FROM chapters WHERE id = ? AND archived_at IS NULL').get(chapterId) as SqlRow | undefined
      if (!row) throw new Error('Không tìm thấy chương để lưu.')
      this.db.prepare('DELETE FROM manuscript_fts WHERE entity_id = ?').run(chapterId)
      this.db.prepare('INSERT INTO manuscript_fts(entity_id, book_id, title, body) VALUES(?, ?, ?, ?)').run(
        chapterId,
        String(row.book_id),
        String(row.title),
        extractText(content)
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.rebuildChapterSummary(chapterId)
    const row = this.db.prepare('SELECT book_id FROM chapters WHERE id = ?').get(chapterId) as SqlRow
    const bookId = String(row.book_id)
    const snapshot = this.getBootstrapSnapshot(bookId)
    const chapter = snapshot.chapters.find((item) => item.id === chapterId)
    if (!chapter) throw new Error('Không tìm thấy chương vừa lưu.')
    return chapter
  }

  getBootstrapSnapshot(bookId = this.getActiveBookId()): BootstrapSnapshot {
    const series = (this.db.prepare(`
      SELECT s.*, COUNT(b.id) AS book_count
      FROM series s LEFT JOIN books b ON b.series_id = s.id AND b.archived_at IS NULL
      WHERE s.archived_at IS NULL
      GROUP BY s.id ORDER BY s.updated_at DESC
    `).all() as SqlRow[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description),
      bookCount: Number(row.book_count),
      updatedAt: String(row.updated_at)
    }))

    const books = (this.db.prepare(`
      SELECT b.* FROM books b JOIN series s ON s.id = b.series_id
      WHERE b.archived_at IS NULL AND s.archived_at IS NULL
      ORDER BY b.updated_at DESC
    `).all() as SqlRow[]).map(mapBook)

    const bookRow = this.db.prepare('SELECT * FROM books WHERE id = ? AND archived_at IS NULL').get(bookId) as SqlRow | undefined
    if (!bookRow) throw new Error('Sách đang mở không tồn tại hoặc đã được lưu trữ.')
    const activeBook = mapBook(bookRow)

    const chapters = (this.db.prepare(`
      SELECT * FROM chapters WHERE book_id = ? AND archived_at IS NULL ORDER BY number ASC
    `).all(bookId) as SqlRow[]).map(mapChapter)
    const brief = this.getLatestBrief(bookId)
    const readiness = calculateBriefReadiness(brief)
    const briefFields = Object.entries(BRIEF_FIELD_LABELS).map(([key, label]) => {
      const typedKey = key as keyof StoryBrief
      const preview = toValuePreview(brief[typedKey])
      return {
        key: typedKey,
        label,
        status: preview === 'Chưa xác định' ? 'unknown' as const : 'confirmed' as const,
        valuePreview: preview,
        sourceMessageId: null
      }
    })

    const outlineVersions = this.listOutlineVersions(bookId)
    const outline = outlineVersions[0]?.chapters ?? []
    const canon = (this.db.prepare('SELECT * FROM canon_facts WHERE book_id = ? ORDER BY created_at ASC').all(bookId) as SqlRow[]).map(mapCanonFact)
    const chapterSummaries = this.listChapterSummaries(bookId, 200)
    const jobs = (this.db.prepare('SELECT * FROM jobs WHERE book_id = ? ORDER BY updated_at DESC LIMIT 5').all(bookId) as SqlRow[]).map((row) => ({
      id: String(row.id),
      bookId: String(row.book_id),
      label: String(row.label),
      roleId: String(row.role_id),
      status: String(row.status) as BootstrapSnapshot['jobs'][number]['status'],
      progress: Number(row.progress),
      detail: String(row.detail),
      startedAt: row.started_at === null ? null : String(row.started_at),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      estimatedCost: Number(row.estimated_cost ?? 0),
      costStatus: String(row.cost_status ?? 'not_applicable') as CostStatus,
      updatedAt: String(row.updated_at)
    }))
    const workflowRuns = this.listWorkflowRuns(bookId)
    const reviewArtifacts = this.listReviewArtifacts(bookId)
    const workingRoles = new Set(workflowRuns.flatMap((run) => run.steps.filter((step) => step.status === 'running').map((step) => step.roleId)))

    const sqliteVersion = this.db.prepare('SELECT sqlite_version() AS version').get() as SqlRow
    const schemaVersion = this.readSchemaVersion()
    const fts5 = Boolean(this.db.prepare("SELECT 1 AS value FROM pragma_module_list WHERE name = 'fts5'").get())

    return BootstrapSnapshotSchema.parse({
      series,
      books,
      activeBook,
      chapters,
      messages: this.listMessages(bookId),
      brief,
      briefFields,
      readiness,
      outline,
      outlineVersions,
      canon,
      chapterSummaries,
      roles: DEFAULT_ROLES.map((role) => ({
        ...role,
        state: workingRoles.has(role.id) ? 'working' as const : role.id === 'director' ? 'ready' as const : 'waiting' as const
      })),
      jobs,
      workflowRuns,
      reviewArtifacts,
      database: { version: String(sqliteVersion.version), fts5, path: this.path, schemaVersion }
    })
  }

  async createBackup(destination: string): Promise<number> {
    mkdirSync(dirname(destination), { recursive: true })
    return backup(this.db, destination, { rate: 32 })
  }

  integrityCheck(): string {
    const result = this.db.prepare('PRAGMA integrity_check').get() as SqlRow
    return String(result.integrity_check)
  }

  getSchemaVersion(): number {
    return this.readSchemaVersion()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private readSchemaVersion(): number {
    const table = this.db.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
    if (!table) return 0
    const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as SqlRow
    return Number(row.version)
  }

  private writeRecoveryEvent(eventType: string, status: string, recoveryPath: string | null, detail: string): void {
    this.db.prepare(`
      INSERT INTO recovery_events(id, event_type, status, recovery_path, detail, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), eventType, status, recoveryPath, detail, new Date().toISOString())
  }

  private writeAudit(eventType: string, entityId: string, data: unknown): void {
    this.db.prepare(`
      INSERT INTO audit_events(id, event_type, entity_id, data_json, created_at) VALUES(?, ?, ?, ?, ?)
    `).run(randomUUID(), eventType, entityId, JSON.stringify(data), new Date().toISOString())
  }
}

function mapBook(row: SqlRow): Book {
  return {
    id: String(row.id),
    seriesId: String(row.series_id),
    title: String(row.title),
    genre: String(row.genre),
    status: String(row.status) as Book['status'],
    targetChapters: Number(row.target_chapters),
    approvedChapters: Number(row.approved_chapters),
    updatedAt: String(row.updated_at)
  }
}

function mapChapter(row: SqlRow): Chapter {
  const id = String(row.id)
  const content = parseJsonColumn<Record<string, unknown>>(
    row.content_json,
    emptyDocument(),
    { table: 'chapters', column: 'content_json', rowId: id },
    isPlainObject
  )
  return {
    id,
    bookId: String(row.book_id),
    number: Number(row.number),
    title: String(row.title),
    summary: String(row.summary),
    status: String(row.status) as Chapter['status'],
    content: content.value,
    contentCorrupt: content.corrupt,
    wordCount: Number(row.word_count),
    updatedAt: String(row.updated_at)
  }
}

function mapOutlineVersion(row: SqlRow): OutlineVersion {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    version: Number(row.version),
    status: String(row.status) as OutlineVersion['status'],
    originVersion: row.origin_version === null || row.origin_version === undefined ? null : Number(row.origin_version),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : String(row.approved_at),
    chapters: parseOutlineChapters(row.data_json, String(row.id)).value
  }
}

function mapCanonFact(row: SqlRow): BootstrapSnapshot['canon'][number] {
  return {
    id: String(row.id),
    bookId: String(row.book_id),
    category: normalizeCanonCategory(String(row.category)),
    subject: String(row.subject),
    fact: String(row.fact),
    sourceChapter: row.source_chapter === null ? null : Number(row.source_chapter),
    confidence: Number(row.confidence)
  }
}

function mapChapterSummary(row: SqlRow): ChapterSummary {
  const id = String(row.id)
  const list = (column: string, raw: unknown): string[] => parseJsonColumn<string[]>(
    raw,
    [],
    { table: 'chapter_summaries', column, rowId: id },
    isStringArray
  ).value
  return {
    id,
    chapterId: String(row.chapter_id),
    bookId: String(row.book_id),
    chapterNumber: Number(row.chapter_number),
    chapterTitle: String(row.chapter_title),
    sourceVersion: Number(row.source_version),
    summary: String(row.summary),
    keyEvents: list('key_events_json', row.key_events_json),
    characters: list('characters_json', row.characters_json),
    locations: list('locations_json', row.locations_json),
    unresolvedThreads: list('unresolved_threads_json', row.unresolved_threads_json),
    tokenEstimate: Number(row.token_estimate),
    updatedAt: String(row.updated_at)
  }
}

function uniqueRowsById(rows: SqlRow[]): SqlRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const id = String(row.id)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function normalizeCanonCategory(value: string): BootstrapSnapshot['canon'][number]['category'] {
  if (value === 'character' || value === 'location' || value === 'rule' || value === 'object') return value
  return 'event'
}

function mapWorkflowStep(row: SqlRow): WorkflowStep {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    ordinal: Number(row.ordinal),
    roleId: String(row.role_id),
    kind: String(row.artifact_kind) as WorkflowArtifactKind,
    label: String(row.label),
    provider: String(row.provider) as WorkflowStep['provider'],
    model: String(row.model),
    contextTokenBudget: Math.max(2_000, Number(row.context_token_budget ?? 16_000)),
    promptVersion: String(row.prompt_version),
    status: String(row.status) as WorkflowStep['status'],
    attemptCount: Number(row.attempt_count),
    requestId: row.request_id === null || row.request_id === undefined ? null : String(row.request_id),
    httpStatus: row.http_status === null || row.http_status === undefined ? null : Number(row.http_status),
    retryCount: Number(row.retry_count ?? 0),
    retryAt: row.retry_at === null || row.retry_at === undefined ? null : String(row.retry_at),
    billingState: String(row.billing_state ?? 'not_started') as WorkflowStep['billingState'],
    costStatus: String(row.cost_status ?? 'not_applicable') as CostStatus,
    lastError: row.last_error === null ? null : String(row.last_error),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at)
  }
}

function mapWorkflowArtifact(row: SqlRow): WorkflowArtifact {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepId: String(row.step_id),
    chapterId: String(row.chapter_id),
    kind: String(row.kind) as WorkflowArtifactKind,
    roleId: String(row.role_id),
    status: String(row.status) as WorkflowArtifact['status'],
    title: String(row.title),
    summary: String(row.summary),
    data: parseJsonColumn<Record<string, unknown>>(
      row.data_json,
      {},
      { table: 'workflow_artifacts', column: 'data_json', rowId: String(row.id) },
      isPlainObject
    ).value,
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at)
  }
}

function emptyDocument(): Record<string, unknown> {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/**
 * Parse một cột JSON của SQLite mà không làm sập cả snapshot.
 *
 * Một dòng hỏng hoặc lệch schema trước đây khiến `getBootstrapSnapshot` throw,
 * làm người dùng mất đường vào toàn bộ workspace lành. Thay vào đó ta ghi nhận
 * dòng hỏng và trả về giá trị dự phòng; dữ liệu gốc trong SQLite không bị sửa.
 */
function parseJsonColumn<T>(
  raw: unknown,
  fallback: T,
  context: { table: string; column: string; rowId: string },
  guard?: (value: unknown) => boolean
): { value: T; corrupt: boolean } {
  if (raw === null || raw === undefined) {
    return { value: fallback, corrupt: true }
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown
    if (guard && !guard(parsed)) {
      throw new Error('Dữ liệu JSON không đúng hình dạng mong đợi.')
    }
    return { value: parsed as T, corrupt: false }
  } catch (error) {
    console.error(`[database] Không đọc được ${context.table}.${context.column} của dòng ${context.rowId}: ${
      error instanceof Error ? error.message : 'lỗi JSON không xác định'
    }. Dòng này được đánh dấu hỏng và giữ nguyên trong SQLite.`)
    return { value: fallback, corrupt: true }
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseOutlineChapters(raw: unknown, rowId: string): { value: OutlineChapter[]; corrupt: boolean } {
  const parsed = parseJsonColumn<unknown[]>(raw, [], { table: 'outline_versions', column: 'data_json', rowId }, Array.isArray)
  const valid = parsed.value.filter((item) => OutlineChapterSchema.safeParse(item).success) as OutlineChapter[]
  return { value: valid, corrupt: parsed.corrupt || valid.length !== parsed.value.length }
}

function extractText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const record = node as Record<string, unknown>
  const ownText = typeof record.text === 'string' ? record.text : ''
  const children = Array.isArray(record.content) ? record.content.map(extractText).join(' ') : ''
  return `${ownText} ${children}`.trim()
}

function removeLeadingDuplicateTitle(contentJson: string, title: string): string | null {
  try {
    const document = JSON.parse(contentJson) as Record<string, unknown>
    if (!Array.isArray(document.content) || document.content.length === 0) return null
    const firstNode = document.content[0]
    if (!firstNode || typeof firstNode !== 'object' || (firstNode as Record<string, unknown>).type !== 'heading') return null
    if (extractText(firstNode).trim() !== title.trim()) return null
    const remainingContent = document.content.slice(1)
    return JSON.stringify({
      ...document,
      content: remainingContent.length > 0 ? remainingContent : [{ type: 'paragraph' }]
    })
  } catch {
    return null
  }
}
