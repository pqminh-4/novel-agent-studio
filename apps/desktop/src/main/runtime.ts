import { join } from 'node:path'
import {
  createOutlineProposal,
  createRoutedArtifactGenerator,
  DurableWorkflowEngine,
  generateDirectorReply,
  NovelDatabase,
  runOfflineDirectorTurn,
  testProvider,
  type ProviderSecret,
  type WorkflowProviderRouteSecret
} from '@infra/index'
import {
  ArchiveBookInputSchema,
  ArchiveChapterInputSchema,
  ArchiveSeriesInputSchema,
  CreateBookInputSchema,
  CreateChapterInputSchema,
  CreateSeriesInputSchema,
  DirectorMessageInputSchema,
  OutlineBookInputSchema,
  OutlineVersionInputSchema,
  RuntimeRequestSchema,
  SaveChapterInputSchema,
  StartWorkflowInputSchema,
  SwitchBookInputSchema,
  UpdateBookInputSchema,
  UpdateChapterInputSchema,
  UpdateSeriesInputSchema,
  WorkflowRunInputSchema,
  ReviewWorkflowInputSchema,
  ProviderRouteSchema,
  type RuntimeResponse
} from '@core/index'

const dataDirectory = process.env.NOVEL_AGENT_DATA_DIRECTORY ?? process.argv[2] ?? join(process.cwd(), '.novel-agent-data')
const database = new NovelDatabase(dataDirectory)
const workflowTimers = new Map<string, ReturnType<typeof setTimeout>>()
const workflowControllers = new Map<string, AbortController>()
const workflowRoutes = new Map<string, WorkflowProviderRouteSecret[]>()
const parentPort = process.parentPort

if (!parentPort) {
  throw new Error('Application Runtime phải được khởi động bằng Electron utilityProcess.')
}

parentPort.on('message', async (event) => {
  const parsed = RuntimeRequestSchema.safeParse(event.data)
  if (!parsed.success) return

  const request = parsed.data
  try {
    const data = await handleRequest(request.channel, request.payload)
    const response: RuntimeResponse = { id: request.id, ok: true, data }
    parentPort.postMessage(response)
    if (request.channel === 'system:shutdown') {
      // Cho response rời utility process trước khi kết thúc tiến trình.
      setTimeout(() => process.exit(0), 0)
    }
  } catch (error) {
    const response: RuntimeResponse = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : 'Application Runtime gặp lỗi không xác định.'
    }
    parentPort.postMessage(response)
  }
})

process.once('exit', () => database.close())

/**
 * Lỗi ngoài luồng xử lý request trước đây sẽ giết utility process mà không đóng
 * SQLite, để lại WAL chưa checkpoint. Ta ghi log, đóng database rồi thoát với mã
 * khác 0 để RuntimeBridge tính vào ceiling khởi động lại.
 */
function handleFatal(kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  console.error(`[runtime:${kind}] ${message}`)
  try {
    workflowTimers.forEach((timer) => clearTimeout(timer))
    workflowControllers.forEach((controller) => controller.abort())
    database.close()
  } catch (closeError) {
    console.error(`[runtime:${kind}] Không thể đóng SQLite sạch: ${closeError instanceof Error ? closeError.message : 'lỗi không xác định'}`)
  }
  process.exit(1)
}

process.on('uncaughtException', (error) => handleFatal('uncaughtException', error))
process.on('unhandledRejection', (reason) => handleFatal('unhandledRejection', reason))

parentPort.postMessage({ type: 'runtime:ready' })

function readOptionalBookId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>).bookId
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 160) throw new Error('Mã sách không hợp lệ.')
  return value
}

async function handleRequest(channel: string, payload: unknown): Promise<unknown> {
  switch (channel) {
    case 'app:bootstrap': {
      const bookId = readOptionalBookId(payload)
      return database.getBootstrapSnapshot(bookId)
    }
    case 'workspace:create-series': {
      database.createSeries(CreateSeriesInputSchema.parse(payload))
      return database.getBootstrapSnapshot()
    }
    case 'workspace:update-series': {
      database.updateSeries(UpdateSeriesInputSchema.parse(payload))
      return database.getBootstrapSnapshot()
    }
    case 'workspace:archive-series': {
      const input = ArchiveSeriesInputSchema.parse(payload)
      database.archiveSeries(input.id)
      return database.getBootstrapSnapshot()
    }
    case 'workspace:create-book': {
      database.createBook(CreateBookInputSchema.parse(payload))
      return database.getBootstrapSnapshot()
    }
    case 'workspace:update-book': {
      database.updateBook(UpdateBookInputSchema.parse(payload))
      return database.getBootstrapSnapshot()
    }
    case 'workspace:archive-book': {
      const input = ArchiveBookInputSchema.parse(payload)
      database.archiveBook(input.id)
      return database.getBootstrapSnapshot()
    }
    case 'workspace:switch-book': {
      const input = SwitchBookInputSchema.parse(payload)
      database.switchBook(input.bookId)
      return database.getBootstrapSnapshot(input.bookId)
    }
    case 'workspace:create-chapter': {
      const input = CreateChapterInputSchema.parse(payload)
      const chapterId = database.createChapter(input)
      return { snapshot: database.getBootstrapSnapshot(input.bookId), chapterId }
    }
    case 'workspace:update-chapter': {
      const input = UpdateChapterInputSchema.parse(payload)
      database.updateChapter(input)
      return database.getBootstrapSnapshot()
    }
    case 'workspace:archive-chapter': {
      const input = ArchiveChapterInputSchema.parse(payload)
      const bookId = database.archiveChapter(input.id)
      return database.getBootstrapSnapshot(bookId)
    }
    case 'director:message': {
      const input = DirectorMessageInputSchema.parse(payload)
      const providerSecret = readProviderSecret(payload)
      database.appendMessage(input.bookId, 'user', input.content)
      const currentBrief = database.getLatestBrief(input.bookId)
      const turn = runOfflineDirectorTurn(currentBrief, input.content)
      database.saveBrief(input.bookId, turn.brief, turn.outlineReady ? 'ready' : 'draft')
      if (turn.outlineReady && turn.updatedField) {
        database.saveOutline(input.bookId, createOutlineProposal(turn.brief))
      }
      let reply = turn.reply
      if (providerSecret) {
        try {
          reply = await generateDirectorReply(providerSecret, {
            brief: turn.brief,
            userMessage: input.content,
            fallbackReply: turn.reply,
            readiness: turn.readiness
          })
        } catch {
          database.appendMessage(input.bookId, 'system', 'Provider đang không phản hồi; Đạo diễn đã tiếp tục bằng chế độ cục bộ an toàn.')
        }
      }
      database.appendMessage(input.bookId, 'director', reply)
      return database.getBootstrapSnapshot(input.bookId)
    }
    case 'chapter:save': {
      const input = SaveChapterInputSchema.parse(payload)
      return database.saveChapter(input.chapterId, input.content, input.wordCount)
    }
    case 'outline:create-proposal': {
      const input = OutlineBookInputSchema.parse(payload)
      database.saveOutline(input.bookId, createOutlineProposal(database.getLatestBrief(input.bookId)))
      return database.getBootstrapSnapshot(input.bookId)
    }
    case 'outline:approve': {
      const input = OutlineVersionInputSchema.parse(payload)
      database.approveOutlineVersion(input.versionId)
      return database.getBootstrapSnapshot()
    }
    case 'outline:restore': {
      const input = OutlineVersionInputSchema.parse(payload)
      database.restoreOutlineVersion(input.versionId)
      return database.getBootstrapSnapshot()
    }
    case 'workflow:start': {
      const input = StartWorkflowInputSchema.parse(payload)
      const routes = readWorkflowRoutes(payload)
      const runId = database.startWorkflow(input.chapterId, input.preset, routes.map(toPublicRoute))
      workflowRoutes.set(runId, routes)
      scheduleWorkflow(runId)
      return database.getBootstrapSnapshot()
    }
    case 'workflow:pause': {
      const input = WorkflowRunInputSchema.parse(payload)
      stopScheduledWorkflow(input.runId)
      database.pauseWorkflow(input.runId)
      return database.getBootstrapSnapshot()
    }
    case 'workflow:resume': {
      const input = WorkflowRunInputSchema.parse(payload)
      workflowRoutes.set(input.runId, readWorkflowRoutes(payload))
      database.resumeWorkflow(input.runId)
      scheduleWorkflow(input.runId)
      return database.getBootstrapSnapshot()
    }
    case 'workflow:retry': {
      const input = WorkflowRunInputSchema.parse(payload)
      workflowRoutes.set(input.runId, readWorkflowRoutes(payload))
      database.retryWorkflow(input.runId)
      scheduleWorkflow(input.runId)
      return database.getBootstrapSnapshot()
    }
    case 'workflow:cancel': {
      const input = WorkflowRunInputSchema.parse(payload)
      stopScheduledWorkflow(input.runId)
      database.cancelWorkflow(input.runId)
      return database.getBootstrapSnapshot()
    }
    case 'workflow:review': {
      const input = ReviewWorkflowInputSchema.parse(payload)
      const bookId = database.reviewWorkflow(input.runId, input.decision)
      return database.getBootstrapSnapshot(bookId)
    }
    case 'backup:create': {
      const input = payload as { destination: string }
      const pages = await database.createBackup(input.destination)
      return { pages, integrity: database.integrityCheck() }
    }
    case 'provider:test':
      return testProvider(payload as ProviderSecret)
    case 'workflow:requirements': {
      const input = WorkflowRunInputSchema.parse(payload)
      return database.getWorkflowRoutes(input.runId)
    }
    case 'system:health':
      return { integrity: database.integrityCheck(), databasePath: database.path, schemaVersion: database.getSchemaVersion() }
    case 'system:shutdown':
      workflowTimers.forEach((timer) => clearTimeout(timer))
      workflowTimers.clear()
      workflowControllers.forEach((controller) => controller.abort())
      workflowControllers.clear()
      database.close()
      return { closed: true }
    default:
      throw new Error(`Kênh runtime không được hỗ trợ: ${channel}`)
  }
}

function scheduleWorkflow(runId: string): void {
  if (workflowTimers.has(runId)) return
  const controller = workflowControllers.get(runId) ?? new AbortController()
  workflowControllers.set(runId, controller)
  const timer = setTimeout(async () => {
    workflowTimers.delete(runId)
    try {
      const generator = createRoutedArtifactGenerator(workflowRoutes.get(runId) ?? [])
      const workflowEngine = new DurableWorkflowEngine(database, 120, generator)
      const status = await workflowEngine.advance(runId, controller.signal)
      if (status === 'queued' || status === 'running') scheduleWorkflow(runId)
      else workflowControllers.delete(runId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Scheduler workflow gặp lỗi không xác định.'
      console.error(`Workflow ${runId} dừng ngoài dự kiến: ${message}`)
      try {
        database.failWorkflowRun(runId, message)
      } catch (persistError) {
        console.error('Không thể lưu trạng thái lỗi workflow.', persistError)
      }
    }
  }, 180)
  workflowTimers.set(runId, timer)
}

function stopScheduledWorkflow(runId: string): void {
  const timer = workflowTimers.get(runId)
  if (timer) clearTimeout(timer)
  workflowTimers.delete(runId)
  workflowControllers.get(runId)?.abort()
  workflowControllers.delete(runId)
}

function readProviderSecret(payload: unknown): ProviderSecret | null {
  if (!payload || typeof payload !== 'object') return null
  const providerSecret = (payload as { providerSecret?: unknown }).providerSecret
  if (!providerSecret || typeof providerSecret !== 'object') return null
  return providerSecret as ProviderSecret
}

function readWorkflowRoutes(payload: unknown): WorkflowProviderRouteSecret[] {
  if (!payload || typeof payload !== 'object') return []
  const value = (payload as { providerRoutes?: unknown }).providerRoutes
  if (!Array.isArray(value)) return []
  return value.map((candidate) => {
    const route = ProviderRouteSchema.parse(candidate)
    if (route.provider === 'demo') return route
    if (!candidate || typeof candidate !== 'object') throw new Error('Cấu hình provider không hợp lệ.')
    const secret = candidate as Record<string, unknown>
    if (typeof secret.endpoint !== 'string' || (route.provider !== 'ollama' && typeof secret.apiKey !== 'string')) {
      throw new Error(`Thiếu thông tin bí mật cho vai trò ${route.roleId}.`)
    }
    return {
      ...route,
      endpoint: secret.endpoint,
      apiKey: typeof secret.apiKey === 'string' ? secret.apiKey : ''
    }
  })
}

function toPublicRoute(route: WorkflowProviderRouteSecret) {
  return ProviderRouteSchema.parse(route)
}
