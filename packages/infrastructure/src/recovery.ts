import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import JSZip from 'jszip'
import {
  BackupInspectionSchema,
  ProjectArchiveManifestSchema,
  RecoveryActionResultSchema,
  RecoveryStatusSchema,
  type BackupInspection,
  type BackupKind,
  type ProjectArchiveManifest,
  type RecoveryActionResult,
  type RecoveryPoint,
  type RecoveryReason,
  type RecoveryStatus
} from '@core/index'

export const CURRENT_SCHEMA_VERSION = 8

const REQUIRED_TABLES = ['schema_migrations', 'series', 'books', 'chapters', 'document_versions'] as const

export class RecoveryValidationError extends Error {
  constructor(readonly reason: RecoveryReason, message: string) {
    super(message)
    this.name = 'RecoveryValidationError'
  }
}

export type PreparedProjectArchive = {
  sourcePath: string
  inspection: BackupInspection
  manifest: ProjectArchiveManifest
  cleanup: () => Promise<void>
}

export function inspectSqliteDatabase(
  databasePath: string,
  kind: BackupKind = 'sqlite',
  metadata: { appVersion?: string | null; createdAt?: string | null } = {}
): BackupInspection {
  const absolutePath = resolve(databasePath)
  if (!existsSync(absolutePath)) throw new RecoveryValidationError('restore_failed', 'Không tìm thấy file database đã chọn.')

  let database: DatabaseSync | null = null
  try {
    database = new DatabaseSync(absolutePath, { readOnly: true, timeout: 5_000 })
    database.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;')
    const integrity = String((database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>).integrity_check ?? '')
    if (integrity !== 'ok') {
      throw new RecoveryValidationError('database_corrupt', `SQLite integrity_check không đạt: ${integrity || 'không có kết quả'}.`)
    }
    for (const table of REQUIRED_TABLES) {
      const exists = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (!exists) throw new RecoveryValidationError('restore_failed', `Backup thiếu bảng bắt buộc: ${table}.`)
    }
    const schemaVersion = Number((database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as Record<string, unknown>).version)
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new RecoveryValidationError('restore_failed', 'Backup không có schema version hợp lệ.')
    }
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new RecoveryValidationError('database_newer', `Backup dùng schema v${schemaVersion}, mới hơn ứng dụng hiện tại v${CURRENT_SCHEMA_VERSION}.`)
    }
    if (schemaVersion >= 8) {
      for (const table of ['series_concept_messages', 'series_concept_brief_versions', 'series_concept_promotions']) {
        const exists = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
        if (!exists) throw new RecoveryValidationError('restore_failed', `Backup schema v8 thiếu bảng bắt buộc: ${table}.`)
      }
    }
    return BackupInspectionSchema.parse({
      kind,
      path: absolutePath,
      appVersion: metadata.appVersion ?? null,
      createdAt: metadata.createdAt ?? null,
      schemaVersion,
      integrity: 'ok',
      sha256: sha256File(absolutePath),
      sizeBytes: statSync(absolutePath).size,
      seriesCount: countRows(database, 'series'),
      bookCount: countRows(database, 'books'),
      chapterCount: countRows(database, 'chapters')
    })
  } catch (error) {
    if (error instanceof RecoveryValidationError) throw error
    throw new RecoveryValidationError('database_corrupt', `Không thể đọc database: ${safeErrorMessage(error)}`)
  } finally {
    database?.close()
  }
}

export function createMigrationBackup(
  database: DatabaseSync,
  dataDirectory: string,
  fromVersion: number,
  toVersion = CURRENT_SCHEMA_VERSION
): string {
  const directory = join(dataDirectory, 'recovery', 'migrations')
  mkdirSync(directory, { recursive: true })
  const createdAt = new Date().toISOString()
  const destination = join(directory, `migration-v${fromVersion}-to-v${toVersion}-${fileTimestamp(createdAt)}-${randomUUID().slice(0, 8)}.sqlite`)
  database.prepare('VACUUM INTO ?').run(destination)
  const inspection = inspectSqliteDatabase(destination, 'migration', { createdAt })
  writeFileSync(`${destination}.json`, `${JSON.stringify({
    kind: 'migration',
    createdAt,
    fromVersion,
    toVersion,
    databaseSha256: inspection.sha256,
    sizeBytes: inspection.sizeBytes
  }, null, 2)}\n`, 'utf8')
  return destination
}

export class RecoveryManager {
  readonly databasePath: string
  readonly recoveryDirectory: string
  private override: { reason: RecoveryReason; detail: string } | null = null

  constructor(readonly dataDirectory: string, private readonly appVersion: string) {
    this.databasePath = join(dataDirectory, 'novel-agent.sqlite')
    this.recoveryDirectory = join(dataDirectory, 'recovery')
    mkdirSync(this.recoveryDirectory, { recursive: true })
  }

  getStatus(): RecoveryStatus {
    const recoveryPoints = this.listRecoveryPoints()
    if (this.override) {
      return RecoveryStatusSchema.parse({
        safeMode: true,
        reason: this.override.reason,
        detail: this.override.detail,
        databasePath: this.databasePath,
        schemaVersion: this.readCurrentSchemaVersion(),
        recoveryPoints
      })
    }
    if (!existsSync(this.databasePath)) {
      return RecoveryStatusSchema.parse({
        safeMode: false,
        reason: null,
        detail: 'Workspace mới sẽ được khởi tạo khi Application Runtime mở.',
        databasePath: this.databasePath,
        schemaVersion: null,
        recoveryPoints
      })
    }
    try {
      const inspection = inspectSqliteDatabase(this.databasePath)
      return RecoveryStatusSchema.parse({
        safeMode: false,
        reason: null,
        detail: 'SQLite integrity_check đạt yêu cầu.',
        databasePath: this.databasePath,
        schemaVersion: inspection.schemaVersion,
        recoveryPoints
      })
    } catch (error) {
      const reason = error instanceof RecoveryValidationError ? error.reason : 'database_corrupt'
      return RecoveryStatusSchema.parse({
        safeMode: true,
        reason,
        detail: safeErrorMessage(error),
        databasePath: this.databasePath,
        schemaVersion: this.readCurrentSchemaVersion(),
        recoveryPoints
      })
    }
  }

  markFailure(reason: RecoveryReason, detail: string): void {
    this.override = { reason, detail }
  }

  clearFailure(): void {
    this.override = null
  }

  inspectBackup(sourcePath: string): BackupInspection {
    return inspectSqliteDatabase(sourcePath, 'sqlite')
  }

  temporarySnapshotPath(): string {
    const directory = join(this.recoveryDirectory, 'temp')
    mkdirSync(directory, { recursive: true })
    return join(directory, `snapshot-${randomUUID()}.sqlite`)
  }

  async createProjectArchive(snapshotPath: string, destination: string): Promise<BackupInspection> {
    const sqlite = inspectSqliteDatabase(snapshotPath, 'sqlite')
    const databaseBytes = await readFile(snapshotPath)
    const createdAt = new Date().toISOString()
    const manifest = ProjectArchiveManifestSchema.parse({
      format: 'novel-agent-project',
      formatVersion: 1,
      appVersion: this.appVersion,
      createdAt,
      schemaVersion: sqlite.schemaVersion,
      databaseFile: 'project.sqlite',
      databaseSha256: sqlite.sha256,
      includesSecrets: false,
      stats: { series: sqlite.seriesCount, books: sqlite.bookCount, chapters: sqlite.chapterCount }
    })
    const zip = new JSZip()
    zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
    zip.file('project.sqlite', databaseBytes)
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
    await mkdir(dirname(destination), { recursive: true })
    const stagingPath = `${destination}.partial-${randomUUID()}`
    await writeFile(stagingPath, archive)
    await replaceDestination(stagingPath, destination)
    return BackupInspectionSchema.parse({
      ...sqlite,
      kind: 'project_archive',
      path: resolve(destination),
      appVersion: manifest.appVersion,
      createdAt,
      sha256: sha256File(destination),
      sizeBytes: statSync(destination).size
    })
  }

  async prepareProjectArchive(archivePath: string): Promise<PreparedProjectArchive> {
    const archiveBytes = await readFile(archivePath)
    const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true })
    const manifestEntry = zip.file('manifest.json')
    const databaseEntry = zip.file('project.sqlite')
    if (!manifestEntry || !databaseEntry) throw new RecoveryValidationError('restore_failed', 'Project archive thiếu manifest.json hoặc project.sqlite.')
    const manifest = ProjectArchiveManifestSchema.parse(JSON.parse(await manifestEntry.async('string')))
    const databaseBytes = await databaseEntry.async('nodebuffer')
    const actualHash = createHash('sha256').update(databaseBytes).digest('hex')
    if (actualHash !== manifest.databaseSha256) {
      throw new RecoveryValidationError('restore_failed', 'Project archive không vượt qua kiểm tra SHA-256.')
    }
    const sourcePath = this.temporarySnapshotPath()
    await writeFile(sourcePath, databaseBytes)
    try {
      const sqlite = inspectSqliteDatabase(sourcePath, 'project_archive', {
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt
      })
      if (sqlite.schemaVersion !== manifest.schemaVersion
        || sqlite.seriesCount !== manifest.stats.series
        || sqlite.bookCount !== manifest.stats.books
        || sqlite.chapterCount !== manifest.stats.chapters) {
        throw new RecoveryValidationError('restore_failed', 'Manifest project archive không khớp nội dung SQLite.')
      }
      return {
        sourcePath,
        inspection: { ...sqlite, path: resolve(archivePath), sha256: sha256File(archivePath), sizeBytes: statSync(archivePath).size },
        manifest,
        cleanup: () => rm(sourcePath, { force: true })
      }
    } catch (error) {
      await rm(sourcePath, { force: true })
      throw error
    }
  }

  async replaceDatabase(sourcePath: string, inspection = inspectSqliteDatabase(sourcePath)): Promise<RecoveryActionResult> {
    const absoluteSource = resolve(sourcePath)
    if (absoluteSource === resolve(this.databasePath)) throw new RecoveryValidationError('restore_failed', 'Không thể restore database từ chính file đang hoạt động.')
    const stagedPath = join(this.dataDirectory, `.restore-${randomUUID()}.sqlite`)
    const displacedPath = join(this.dataDirectory, `.displaced-${randomUUID()}.sqlite`)
    await mkdir(this.dataDirectory, { recursive: true })
    await copyFile(absoluteSource, stagedPath)
    inspectSqliteDatabase(stagedPath, inspection.kind, { appVersion: inspection.appVersion, createdAt: inspection.createdAt })

    let recoveryPointPath: string | null = null
    let displaced = false
    try {
      if (existsSync(this.databasePath)) recoveryPointPath = await this.createPreRestorePoint()
      await removeSqliteSidecars(this.databasePath)
      if (existsSync(this.databasePath)) {
        await rename(this.databasePath, displacedPath)
        displaced = true
      }
      try {
        await rename(stagedPath, this.databasePath)
      } catch (error) {
        if (displaced && !existsSync(this.databasePath) && existsSync(displacedPath)) await rename(displacedPath, this.databasePath)
        throw error
      }
      if (displaced) await rm(displacedPath, { force: true }).catch(() => undefined)
      recordRecoveryEventIfSupported(
        this.databasePath,
        inspection.kind === 'project_archive' ? 'project_import' : 'backup_restore',
        recoveryPointPath,
        `Đã khôi phục schema v${inspection.schemaVersion}.`
      )
      this.clearFailure()
      return RecoveryActionResultSchema.parse({
        path: this.databasePath,
        recoveryPointPath,
        restartRequired: true,
        inspection
      })
    } catch (error) {
      this.markFailure('restore_failed', `Không thể thay database: ${safeErrorMessage(error)}`)
      throw error
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined)
    }
  }

  listRecoveryPoints(): RecoveryPoint[] {
    if (!existsSync(this.recoveryDirectory)) return []
    const files = walkRecoveryFiles(this.recoveryDirectory)
    return files.map((path) => {
      const stats = statSync(path)
      try {
        const kind = inferRecoveryKind(path)
        const inspection = inspectSqliteDatabase(path, kind)
        return {
          path,
          kind,
          createdAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
          schemaVersion: inspection.schemaVersion,
          integrity: 'ok' as const
        }
      } catch {
        return {
          path,
          kind: inferRecoveryKind(path),
          createdAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
          schemaVersion: null,
          integrity: 'unreadable' as const
        }
      }
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50)
  }

  private async createPreRestorePoint(): Promise<string> {
    const directory = join(this.recoveryDirectory, 'restore')
    await mkdir(directory, { recursive: true })
    const createdAt = new Date().toISOString()
    const destination = join(directory, `pre-restore-${fileTimestamp(createdAt)}-${randomUUID().slice(0, 8)}.sqlite`)
    let database: DatabaseSync | null = null
    try {
      database = new DatabaseSync(this.databasePath, { timeout: 5_000 })
      const integrity = String((database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>).integrity_check ?? '')
      if (integrity !== 'ok') throw new Error(integrity)
      database.prepare('VACUUM INTO ?').run(destination)
    } catch {
      database?.close()
      database = null
      await copyFile(this.databasePath, destination)
      await copySidecarIfPresent(`${this.databasePath}-wal`, `${destination}-wal`)
      await copySidecarIfPresent(`${this.databasePath}-shm`, `${destination}-shm`)
    } finally {
      database?.close()
    }
    const rawHash = sha256File(destination)
    await writeFile(`${destination}.json`, `${JSON.stringify({
      kind: 'pre_restore',
      createdAt,
      source: basename(this.databasePath),
      databaseSha256: rawHash
    }, null, 2)}\n`, 'utf8')
    return destination
  }

  private readCurrentSchemaVersion(): number | null {
    if (!existsSync(this.databasePath)) return null
    let database: DatabaseSync | null = null
    try {
      database = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 2_000 })
      const table = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
      if (!table) return 0
      return Number((database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as Record<string, unknown>).version)
    } catch {
      return null
    } finally {
      database?.close()
    }
  }
}

function countRows(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, unknown>).count)
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileTimestamp(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Lỗi không xác định.'
}

function walkRecoveryFiles(root: string): string[] {
  const output: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...walkRecoveryFiles(path))
    else if (entry.isFile() && extname(entry.name).toLocaleLowerCase() === '.sqlite') output.push(path)
  }
  return output
}

function inferRecoveryKind(path: string): BackupKind {
  const name = basename(path).toLocaleLowerCase()
  if (name.startsWith('migration-')) return 'migration'
  if (name.startsWith('pre-restore-')) return 'pre_restore'
  return 'sqlite'
}

async function replaceDestination(stagingPath: string, destination: string): Promise<void> {
  try {
    await rename(stagingPath, destination)
  } catch (error) {
    if (!existsSync(destination)) throw error
    await rm(destination, { force: true })
    await rename(stagingPath, destination)
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all([
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true })
  ])
}

async function copySidecarIfPresent(source: string, destination: string): Promise<void> {
  if (existsSync(source)) await copyFile(source, destination)
}

function recordRecoveryEventIfSupported(databasePath: string, eventType: string, recoveryPath: string | null, detail: string): void {
  let database: DatabaseSync | null = null
  try {
    database = new DatabaseSync(databasePath, { timeout: 5_000 })
    const table = database.prepare("SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'recovery_events'").get()
    if (!table) return
    database.prepare(`
      INSERT INTO recovery_events(id, event_type, status, recovery_path, detail, created_at)
      VALUES(?, ?, 'completed', ?, ?, ?)
    `).run(randomUUID(), eventType, recoveryPath, detail, new Date().toISOString())
  } catch {
    // Nhật ký là best-effort; database đã được thay an toàn trước bước này.
  } finally {
    database?.close()
  }
}
