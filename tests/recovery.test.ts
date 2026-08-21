import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  NovelDatabase,
  RecoveryManager,
  RecoveryValidationError,
  inspectSqliteDatabase
} from '@infra/index'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function setActiveBookTitle(database: NovelDatabase, title: string): void {
  const book = database.getBootstrapSnapshot().activeBook
  database.updateBook({ ...book, title })
}

describe('khôi phục dữ liệu P0.5', () => {
  it('kiểm tra SQLite backup và chuyển database hỏng sang Safe Mode', async () => {
    const sourceDirectory = temporaryDirectory('novel-agent-recovery-inspect-')
    const backupPath = join(sourceDirectory, 'verified.sqlite')
    const database = new NovelDatabase(sourceDirectory)
    await database.createBackup(backupPath)
    database.close()

    const inspection = inspectSqliteDatabase(backupPath)
    expect(inspection).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      integrity: 'ok',
      seriesCount: 1,
      bookCount: 1,
      chapterCount: 6
    })

    const corruptDirectory = temporaryDirectory('novel-agent-recovery-corrupt-')
    writeFileSync(join(corruptDirectory, 'novel-agent.sqlite'), 'không phải sqlite', 'utf8')
    const status = new RecoveryManager(corruptDirectory, '0.1.5').getStatus()
    expect(status).toMatchObject({ safeMode: true, reason: 'database_corrupt', schemaVersion: null })
  })

  it('project archive có manifest, checksum và round-trip database không chứa secret', async () => {
    const directory = temporaryDirectory('novel-agent-project-archive-')
    const database = new NovelDatabase(directory)
    setActiveBookTitle(database, 'Bản archive toàn vẹn')
    const snapshotPath = join(directory, 'snapshot.sqlite')
    await database.createBackup(snapshotPath)
    database.close()

    const manager = new RecoveryManager(directory, '0.1.5')
    const archivePath = join(directory, 'project.novelproj')
    const exported = await manager.createProjectArchive(snapshotPath, archivePath)
    expect(exported).toMatchObject({ kind: 'project_archive', appVersion: '0.1.5', integrity: 'ok' })

    const zip = await JSZip.loadAsync(readFileSync(archivePath), { checkCRC32: true })
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Record<string, unknown>
    expect(manifest).toMatchObject({ format: 'novel-agent-project', formatVersion: 1, includesSecrets: false })
    expect(JSON.stringify(manifest)).not.toContain('apiKey')

    const prepared = await manager.prepareProjectArchive(archivePath)
    const restored = new DatabaseSync(prepared.sourcePath, { readOnly: true })
    expect(restored.prepare('SELECT title FROM books WHERE archived_at IS NULL LIMIT 1').get()).toMatchObject({ title: 'Bản archive toàn vẹn' })
    restored.close()
    await prepared.cleanup()

    zip.file('project.sqlite', Buffer.from('nội dung đã bị thay đổi'))
    const tamperedPath = join(directory, 'tampered.novelproj')
    writeFileSync(tamperedPath, await zip.generateAsync({ type: 'nodebuffer' }))
    await expect(manager.prepareProjectArchive(tamperedPath)).rejects.toThrow('SHA-256')
  })

  it('restore thay database qua staging và giữ recovery point của workspace cũ', async () => {
    const currentDirectory = temporaryDirectory('novel-agent-restore-current-')
    const sourceDirectory = temporaryDirectory('novel-agent-restore-source-')
    const current = new NovelDatabase(currentDirectory)
    setActiveBookTitle(current, 'Workspace trước restore')
    current.close()

    const source = new NovelDatabase(sourceDirectory)
    setActiveBookTitle(source, 'Workspace từ backup')
    const sourceBackup = join(sourceDirectory, 'source.sqlite')
    await source.createBackup(sourceBackup)
    source.close()

    const manager = new RecoveryManager(currentDirectory, '0.1.5')
    const inspection = manager.inspectBackup(sourceBackup)
    const result = await manager.replaceDatabase(sourceBackup, inspection)
    expect(result).toMatchObject({ restartRequired: true, recoveryPointPath: expect.stringContaining('pre-restore-') })

    const reopened = new NovelDatabase(currentDirectory)
    expect(reopened.getBootstrapSnapshot().activeBook.title).toBe('Workspace từ backup')
    reopened.close()

    const restoredDatabase = new DatabaseSync(join(currentDirectory, 'novel-agent.sqlite'), { readOnly: true })
    expect(restoredDatabase.prepare("SELECT COUNT(*) AS count FROM recovery_events WHERE event_type = 'backup_restore'").get()).toEqual({ count: 1 })
    restoredDatabase.close()

    const recoveryPoint = new DatabaseSync(result.recoveryPointPath!, { readOnly: true })
    expect(recoveryPoint.prepare('SELECT title FROM books WHERE archived_at IS NULL LIMIT 1').get()).toMatchObject({ title: 'Workspace trước restore' })
    expect(recoveryPoint.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    recoveryPoint.close()
  })

  it('backup lỗi bị chặn trước khi thay đổi workspace hiện tại', () => {
    const directory = temporaryDirectory('novel-agent-restore-reject-')
    const database = new NovelDatabase(directory)
    setActiveBookTitle(database, 'Dữ liệu phải giữ nguyên')
    database.close()
    const invalidPath = join(directory, 'invalid.sqlite')
    writeFileSync(invalidPath, 'file lỗi', 'utf8')
    const manager = new RecoveryManager(directory, '0.1.5')

    expect(() => manager.inspectBackup(invalidPath)).toThrow(RecoveryValidationError)
    const reopened = new NovelDatabase(directory)
    expect(reopened.getBootstrapSnapshot().activeBook.title).toBe('Dữ liệu phải giữ nguyên')
    reopened.close()
  })

  it('tự tạo migration backup trước khi nâng lên schema hiện tại', () => {
    const directory = temporaryDirectory('novel-agent-migration-backup-')
    const initial = new NovelDatabase(directory)
    setActiveBookTitle(initial, 'Dữ liệu trước migration v8')
    initial.close()

    const sqlite = new DatabaseSync(join(directory, 'novel-agent.sqlite'))
    sqlite.exec(`
      DELETE FROM schema_migrations WHERE version = 8;
      DROP TABLE series_concept_promotions;
      DROP TABLE series_concept_messages;
      DROP TABLE series_concept_brief_versions;
    `)
    sqlite.close()

    const migrated = new NovelDatabase(directory)
    expect(migrated.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.getBootstrapSnapshot().activeBook.title).toBe('Dữ liệu trước migration v8')
    migrated.close()

    const migrationDirectory = join(directory, 'recovery', 'migrations')
    const backups = readdirSync(migrationDirectory).filter((name) => name.endsWith('.sqlite'))
    expect(backups).toHaveLength(1)
    const migrationBackup = inspectSqliteDatabase(join(migrationDirectory, backups[0]), 'migration')
    expect(migrationBackup).toMatchObject({ schemaVersion: 7, integrity: 'ok' })

    const verified = new DatabaseSync(join(directory, 'novel-agent.sqlite'), { readOnly: true })
    expect(verified.prepare("SELECT COUNT(*) AS count FROM recovery_events WHERE event_type = 'migration_backup'").get()).toEqual({ count: 1 })
    verified.close()
  })
})
