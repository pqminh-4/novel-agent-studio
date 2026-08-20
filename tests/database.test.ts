import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createOutlineProposal, NovelDatabase, runOfflineDirectorTurn } from '@infra/index'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

describe('migration nội dung chương', () => {
  it('loại heading đầu trùng tiêu đề nhưng giữ nguyên phần văn bản còn lại', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-database-'))
    temporaryDirectories.push(directory)

    const initialDatabase = new NovelDatabase(directory)
    initialDatabase.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    sqlite.prepare('DELETE FROM schema_migrations WHERE version = 2').run()
    sqlite.prepare('UPDATE chapters SET content_json = ? WHERE id = ?').run(JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Ngọn đèn tắt' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Nội dung phải được giữ lại.' }] }
      ]
    }), 'chapter-1')
    sqlite.close()

    const migratedDatabase = new NovelDatabase(directory)
    const firstChapter = migratedDatabase.getBootstrapSnapshot().chapters[0]
    migratedDatabase.close()

    expect(firstChapter.content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nội dung phải được giữ lại.' }] }]
    })
  })

  it('giữ autosave sau khi mở lại và tạo backup toàn vẹn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-persistence-'))
    temporaryDirectories.push(directory)
    const backupPath = join(directory, 'backup.sqlite')

    const initialDatabase = new NovelDatabase(directory)
    initialDatabase.saveChapter('chapter-1', {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dòng autosave phải tồn tại sau khi khởi động lại.' }] }]
    }, 9)
    await initialDatabase.createBackup(backupPath)
    initialDatabase.close()

    const reopenedDatabase = new NovelDatabase(directory)
    expect(reopenedDatabase.getBootstrapSnapshot().chapters[0].wordCount).toBe(9)
    expect(reopenedDatabase.getBootstrapSnapshot().chapters[0].content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Dòng autosave phải tồn tại sau khi khởi động lại.' }] }]
    })
    reopenedDatabase.close()

    const backupDatabase = new DatabaseSync(backupPath)
    expect(backupDatabase.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    backupDatabase.close()
  })

  it('lưu brief hoàn chỉnh cùng phiên bản dàn ý tự sinh', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-outline-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(directory)
    const bookId = database.getActiveBookId()
    const turn = runOfflineDirectorTurn(database.getLatestBrief(bookId), 'Chiến thắng có đánh đổi nhưng vẫn mở ra hy vọng.')

    database.saveBrief(bookId, turn.brief, 'ready')
    database.saveOutline(bookId, createOutlineProposal(turn.brief))
    const snapshot = database.getBootstrapSnapshot(bookId)
    database.close()

    expect(snapshot.readiness).toBe(100)
    expect(snapshot.outline).toHaveLength(24)
    expect(snapshot.activeBook.targetChapters).toBe(24)
  })
})

describe('workspace P0.1', () => {
  it('thực hiện CRUD series, sách và chương mà không xóa vật lý dữ liệu', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-workspace-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(directory)

    const seriesId = database.createSeries({ name: 'Biên niên sử Sao Rơi', description: 'Series thử nghiệm.' })
    database.updateSeries({ id: seriesId, name: 'Biên niên sử Sao Rơi II', description: 'Đã cập nhật.' })
    const bookId = database.createBook({
      seriesId,
      title: 'Quỹ đạo cuối cùng',
      genre: 'Khoa học viễn tưởng',
      status: 'writing',
      targetChapters: 18
    })
    database.updateBook({
      id: bookId,
      seriesId,
      title: 'Quỹ đạo sau cùng',
      genre: 'Khoa học viễn tưởng',
      status: 'writing',
      targetChapters: 20
    })
    const chapterId = database.createChapter({ bookId, title: 'Tín hiệu đầu tiên', summary: 'Mở ra bí ẩn.', status: 'planned' })
    database.updateChapter({ id: chapterId, title: 'Tín hiệu từ xa', summary: 'Mở ra bí ẩn trung tâm.', status: 'drafting' })

    let snapshot = database.getBootstrapSnapshot(bookId)
    expect(snapshot.series.find((series) => series.id === seriesId)?.name).toBe('Biên niên sử Sao Rơi II')
    expect(snapshot.activeBook).toMatchObject({ id: bookId, title: 'Quỹ đạo sau cùng', targetChapters: 20 })
    expect(snapshot.chapters[0]).toMatchObject({ id: chapterId, title: 'Tín hiệu từ xa', status: 'drafting' })

    database.archiveChapter(chapterId)
    snapshot = database.getBootstrapSnapshot(bookId)
    expect(snapshot.chapters).toHaveLength(0)

    database.archiveBook(bookId)
    snapshot = database.getBootstrapSnapshot()
    expect(snapshot.books.some((book) => book.id === bookId)).toBe(false)
    database.archiveSeries(seriesId)
    expect(database.getBootstrapSnapshot().series.some((series) => series.id === seriesId)).toBe(false)
    database.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    expect(sqlite.prepare('SELECT archived_at FROM chapters WHERE id = ?').get(chapterId)).toMatchObject({ archived_at: expect.any(String) })
    expect(sqlite.prepare('SELECT archived_at FROM books WHERE id = ?').get(bookId)).toMatchObject({ archived_at: expect.any(String) })
    expect(sqlite.prepare('SELECT archived_at FROM series WHERE id = ?').get(seriesId)).toMatchObject({ archived_at: expect.any(String) })
    sqlite.close()
  })

  it('không cho lưu trữ sách hoạt động cuối cùng', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-last-book-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(directory)
    expect(() => database.archiveBook(database.getActiveBookId())).toThrow('Cần ít nhất một sách hoạt động')
    expect(database.getBootstrapSnapshot().books).toHaveLength(1)
    database.close()
  })

  it('duyệt và khôi phục dàn ý bằng phiên bản mới, không sửa phiên bản nguồn', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-outline-version-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(directory)
    const source = database.getBootstrapSnapshot().outlineVersions[0]

    database.approveOutlineVersion(source.id)
    const approved = database.getBootstrapSnapshot().outlineVersions.find((version) => version.id === source.id)
    database.restoreOutlineVersion(source.id)
    const versions = database.getBootstrapSnapshot().outlineVersions
    const restored = versions[0]
    const unchangedSource = versions.find((version) => version.id === source.id)
    database.close()

    expect(approved?.status).toBe('approved')
    expect(restored).toMatchObject({ version: source.version + 1, status: 'restored', originVersion: source.version })
    expect(restored.id).not.toBe(source.id)
    expect(restored.chapters).toEqual(source.chapters)
    expect(unchangedSource).toMatchObject({ id: source.id, version: source.version, status: 'approved' })
  })

  it('migration v3 có thể chạy lại mà vẫn giữ dữ liệu hiện hữu', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-migration-v3-'))
    temporaryDirectories.push(directory)
    const initialDatabase = new NovelDatabase(directory)
    const activeBookId = initialDatabase.getActiveBookId()
    initialDatabase.updateBook({
      ...initialDatabase.getBootstrapSnapshot().activeBook,
      title: 'Tên sách phải được giữ lại'
    })
    initialDatabase.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    sqlite.prepare('DELETE FROM schema_migrations WHERE version = 3').run()
    sqlite.close()

    const migratedDatabase = new NovelDatabase(directory)
    expect(migratedDatabase.getBootstrapSnapshot(activeBookId).activeBook.title).toBe('Tên sách phải được giữ lại')
    migratedDatabase.close()
  })

  it('nâng database v3 lên workflow schema v4 mà không làm mất dữ liệu', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-migration-v4-'))
    temporaryDirectories.push(directory)
    const initialDatabase = new NovelDatabase(directory)
    const activeBook = initialDatabase.getBootstrapSnapshot().activeBook
    initialDatabase.updateBook({ ...activeBook, title: 'Dữ liệu v3 phải còn nguyên' })
    initialDatabase.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    sqlite.exec(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM schema_migrations WHERE version = 4;
      DROP TABLE usage_ledger;
      DROP TABLE workflow_events;
      DROP TABLE workflow_artifacts;
      DROP TABLE workflow_attempts;
      DROP TABLE workflow_steps;
      DROP TABLE workflow_runs;
      ALTER TABLE jobs RENAME TO jobs_v4;
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        role_id TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO jobs(id, book_id, label, role_id, status, progress, detail, started_at, updated_at)
      SELECT id, book_id, label, role_id, status, progress, detail, started_at, updated_at FROM jobs_v4;
      DROP TABLE jobs_v4;
      PRAGMA foreign_keys = ON;
    `)
    sqlite.prepare(`
      INSERT INTO jobs(id, book_id, label, role_id, status, progress, detail, updated_at)
      VALUES('legacy-job', ?, 'Job v3', 'director', 'completed', 100, 'Đã xong', ?)
    `).run(activeBook.id, new Date().toISOString())
    sqlite.close()

    const migratedDatabase = new NovelDatabase(directory)
    const snapshot = migratedDatabase.getBootstrapSnapshot(activeBook.id)
    expect(snapshot.activeBook.title).toBe('Dữ liệu v3 phải còn nguyên')
    expect(snapshot.jobs.find((job) => job.id === 'legacy-job')).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0
    })
    migratedDatabase.close()

    const migratedSqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    expect(migratedSqlite.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 4').get()).toEqual({ value: 1 })
    expect(migratedSqlite.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'").get()).toEqual({ value: 1 })
    migratedSqlite.close()
  })

  it('migration v5 bổ sung audit live-provider mà vẫn giữ dữ liệu hiện hữu', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-migration-v5-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(directory)
    const activeBook = database.getBootstrapSnapshot().activeBook
    database.updateBook({ ...activeBook, title: 'Dữ liệu phải tồn tại qua migration v5' })
    database.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    expect(sqlite.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 5').get()).toEqual({ value: 1 })
    const stepColumns = sqlite.prepare('PRAGMA table_info(workflow_steps)').all() as Array<{ name: string }>
    const attemptColumns = sqlite.prepare('PRAGMA table_info(workflow_attempts)').all() as Array<{ name: string }>
    expect(stepColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['request_id', 'retry_at', 'billing_state', 'cost_status']))
    expect(attemptColumns.map((column) => column.name)).toEqual(expect.arrayContaining(['provider', 'model', 'request_id', 'billing_state']))
    sqlite.close()

    const reopened = new NovelDatabase(directory)
    expect(reopened.getBootstrapSnapshot(activeBook.id).activeBook.title).toBe('Dữ liệu phải tồn tại qua migration v5')
    reopened.close()
  })

  it('migration v6 backfill chapter summary và FTS context mà không đổi bản thảo', () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-migration-v6-'))
    temporaryDirectories.push(directory)
    const initial = new NovelDatabase(directory)
    const originalChapter = initial.getBootstrapSnapshot().chapters[0]
    initial.saveChapter(originalChapter.id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'An giữ chiếc đèn thủy tinh và vẫn chưa biết ai đã xóa ký ức?' }] }]
    }, 15)
    initial.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    sqlite.prepare('DELETE FROM schema_migrations WHERE version = 6').run()
    sqlite.exec('DROP TABLE chapter_summaries; DROP TABLE context_fts;')
    sqlite.close()

    const migrated = new NovelDatabase(directory)
    const snapshot = migrated.getBootstrapSnapshot()
    const migratedSummary = snapshot.chapterSummaries.find((summary) => summary.chapterId === originalChapter.id)
    migrated.close()
    expect(snapshot.chapters[0].content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'An giữ chiếc đèn thủy tinh và vẫn chưa biết ai đã xóa ký ức?' }] }]
    })
    expect(migratedSummary).toMatchObject({ chapterId: originalChapter.id, sourceVersion: 1 })

    const verified = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    expect(verified.prepare('SELECT 1 AS value FROM schema_migrations WHERE version = 6').get()).toEqual({ value: 1 })
    expect(verified.prepare("SELECT COUNT(*) AS count FROM context_fts WHERE entity_type = 'chapter_summary'").get()).toMatchObject({ count: expect.any(Number) })
    verified.close()
  })
})
