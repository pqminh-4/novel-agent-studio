import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { NovelDatabase } from '@infra/index'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function createWorkspace(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  const database = new NovelDatabase(directory)
  database.close()
  return directory
}

function openRaw(directory: string): DatabaseSync {
  return new DatabaseSync(join(directory, 'novel-agent.sqlite'))
}

describe('khả năng chịu dữ liệu JSON hỏng', () => {
  it('vẫn mở được workspace khi content_json của một chương không parse được', () => {
    const directory = createWorkspace('novel-agent-corrupt-chapter-')

    const sqlite = openRaw(directory)
    const chapters = sqlite.prepare('SELECT id FROM chapters ORDER BY number ASC').all() as { id: string }[]
    expect(chapters.length).toBeGreaterThan(1)
    const corruptId = chapters[0].id
    const healthyId = chapters[1].id
    sqlite.prepare('UPDATE chapters SET content_json = ? WHERE id = ?').run('{"type":"doc","content":[', corruptId)
    sqlite.close()

    const database = new NovelDatabase(directory)
    const snapshot = database.getBootstrapSnapshot()
    database.close()

    // Trước khi vá, một dòng hỏng làm getBootstrapSnapshot throw và người dùng
    // mất đường vào toàn bộ workspace lành.
    const corrupt = snapshot.chapters.find((chapter) => chapter.id === corruptId)
    const healthy = snapshot.chapters.find((chapter) => chapter.id === healthyId)
    expect(corrupt?.contentCorrupt).toBe(true)
    expect(corrupt?.content).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    expect(healthy?.contentCorrupt).toBe(false)
    expect(snapshot.chapters).toHaveLength(chapters.length)
  })

  it('không cho autosave ghi đè lên chương có nội dung hỏng và giữ nguyên bản gốc', () => {
    const directory = createWorkspace('novel-agent-corrupt-guard-')
    const rawContent = '{"type":"doc","content":[{"type":"paragraph"'

    const sqlite = openRaw(directory)
    const chapterId = String((sqlite.prepare('SELECT id FROM chapters ORDER BY number ASC').get() as { id: string }).id)
    sqlite.prepare('UPDATE chapters SET content_json = ? WHERE id = ?').run(rawContent, chapterId)
    sqlite.close()

    const database = new NovelDatabase(directory)
    expect(() => database.saveChapter(chapterId, { type: 'doc', content: [{ type: 'paragraph' }] }, 0))
      .toThrow(/chỉ đọc/)
    database.close()

    const verify = openRaw(directory)
    const stored = verify.prepare('SELECT content_json FROM chapters WHERE id = ?').get(chapterId) as { content_json: string }
    verify.close()
    expect(stored.content_json).toBe(rawContent)
  })

  it('bỏ qua mục dàn ý hỏng thay vì làm sập snapshot', () => {
    const directory = createWorkspace('novel-agent-corrupt-outline-')

    const sqlite = openRaw(directory)
    const outline = sqlite.prepare('SELECT id FROM outline_versions ORDER BY version DESC LIMIT 1').get() as { id: string } | undefined
    expect(outline).toBeDefined()
    sqlite.prepare('UPDATE outline_versions SET data_json = ? WHERE id = ?').run('[{"number":1,"title":"Còn dùng được","purpose":"giữ lại","status":"planned"},{"number":"hỏng"}]', outline!.id)
    sqlite.close()

    const database = new NovelDatabase(directory)
    const snapshot = database.getBootstrapSnapshot()
    database.close()

    const version = snapshot.outlineVersions.find((item) => item.id === outline!.id)
    expect(version?.chapters).toEqual([{ number: 1, title: 'Còn dùng được', purpose: 'giữ lại', status: 'planned' }])
  })

  it('quay về brief mặc định khi brief_versions.data_json hỏng', () => {
    const directory = createWorkspace('novel-agent-corrupt-brief-')

    const sqlite = openRaw(directory)
    const bookId = String((sqlite.prepare('SELECT id FROM books LIMIT 1').get() as { id: string }).id)
    sqlite.prepare('INSERT INTO brief_versions(id, book_id, version, data_json, status, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run('brief-corrupt', bookId, 999, 'không phải JSON', 'draft', new Date().toISOString())
    sqlite.close()

    const database = new NovelDatabase(directory)
    const brief = database.getLatestBrief(bookId)
    const snapshot = database.getBootstrapSnapshot(bookId)
    database.close()

    expect(brief).toBeDefined()
    expect(snapshot.readiness).toBeGreaterThanOrEqual(0)
  })

  it('bỏ qua chapter_summaries hỏng mà vẫn giữ các summary lành', () => {
    const directory = createWorkspace('novel-agent-corrupt-summary-')

    const sqlite = openRaw(directory)
    const summary = sqlite.prepare('SELECT id FROM chapter_summaries LIMIT 1').get() as { id: string } | undefined
    if (!summary) {
      sqlite.close()
      return
    }
    sqlite.prepare('UPDATE chapter_summaries SET key_events_json = ? WHERE id = ?').run('{broken', summary.id)
    sqlite.close()

    const database = new NovelDatabase(directory)
    const snapshot = database.getBootstrapSnapshot()
    database.close()

    const mapped = snapshot.chapterSummaries.find((item) => item.id === summary.id)
    expect(mapped?.keyEvents).toEqual([])
  })
})
