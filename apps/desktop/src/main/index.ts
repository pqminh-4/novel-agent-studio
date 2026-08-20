import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, normalize, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell
} from 'electron'
import type { BackupInspection, BootstrapSnapshot, ProviderKind, ProviderRoute, RecoveryActionResult } from '@core/index'
import { RecoveryManager, type WorkflowProviderRouteSecret } from '@infra/index'
import { RuntimeBridge } from './runtime-bridge'
import { CredentialVault, type ProviderConnectionInput } from './vault'
import { exportBook, suggestFileName, type ExportFormat } from './exporters'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'novel-agent',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
  }
])

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('in-process-gpu')

let mainWindow: BrowserWindow | null = null
let runtime: RuntimeBridge | null = null
let vault: CredentialVault
let recovery: RecoveryManager

const RUNTIME_CHANNELS = new Set([
  'app:bootstrap',
  'director:message',
  'chapter:save',
  'workspace:create-series',
  'workspace:update-series',
  'workspace:archive-series',
  'workspace:create-book',
  'workspace:update-book',
  'workspace:archive-book',
  'workspace:switch-book',
  'workspace:create-chapter',
  'workspace:update-chapter',
  'workspace:archive-chapter',
  'outline:create-proposal',
  'outline:approve',
  'outline:restore',
  'workflow:start',
  'workflow:pause',
  'workflow:resume',
  'workflow:retry',
  'workflow:cancel',
  'workflow:review',
  'system:health'
])

void app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const dataDirectory = join(userData, 'data')
  recovery = new RecoveryManager(dataDirectory, app.getVersion())
  vault = new CredentialVault(join(userData, 'vault', 'connections.json'))
  const recoveryStatus = recovery.getStatus()
  if (!recoveryStatus.safeMode) {
    try {
      runtime = createRuntimeBridge(dataDirectory)
      await runtime.start()
    } catch (error) {
      await runtime?.stop()
      runtime = null
      recovery.markFailure('runtime_startup', error instanceof Error ? error.message : 'Application Runtime không thể khởi động.')
    }
  }
  registerProtocol()
  registerSecurityPolicy()
  registerIpc()
  createWindow()
}).catch((error) => {
  console.error(`[startup] ${sanitizeDiagnostic(error instanceof Error ? error.message : 'Lỗi không xác định')}`)
  dialog.showErrorBox('Không thể khởi động Novel Agent Studio', 'Application Runtime không thể mở. Dữ liệu của bạn chưa bị thay đổi.')
  app.quit()
})

app.on('window-all-closed', () => {
  void runtime?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1512,
    height: 940,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#12110f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#151411',
      symbolColor: '#a9a297',
      height: 38
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('novel-agent://app') || url.startsWith('http://localhost:')
    if (!allowed) event.preventDefault()
  })
  window.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level < 2) return
    const details = event as unknown as {
      level?: string
      message?: string
      lineNumber?: number
      sourceId?: string
    }
    const safeMessage = sanitizeDiagnostic(details.message ?? message)
    const safeSource = sanitizeDiagnostic(details.sourceId ?? sourceId, 180)
    const safeLevel = details.level ?? (level === 3 ? 'error' : 'warning')
    console.error(`[renderer:${safeLevel}] ${safeMessage} (${safeSource}:${details.lineNumber ?? line})`)
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload-error] ${sanitizeDiagnostic(error.message)} (${sanitizeDiagnostic(preloadPath, 180)})`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadURL('novel-agent://app/index.html')
  }
}

function registerProtocol(): void {
  protocol.handle('novel-agent', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Không tìm thấy', { status: 404 })
    const rendererRoot = normalize(join(__dirname, '../renderer'))
    const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const filePath = normalize(join(rendererRoot, requestedPath))
    if (relative(rendererRoot, filePath).startsWith('..') || !existsSync(filePath)) {
      return new Response('Không tìm thấy', { status: 404 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function registerSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const scriptPolicy = app.isPackaged ? "script-src 'self'" : "script-src 'self' 'unsafe-inline'"
    const connectPolicy = app.isPackaged ? "connect-src 'self'" : "connect-src 'self' ws://localhost:* http://localhost:*"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' novel-asset: data:; font-src 'self' data:; ${connectPolicy}; object-src 'none'; frame-src 'none'; base-uri 'none'`
        ]
      }
    })
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
}

function registerIpc(): void {
  ipcMain.handle('runtime:invoke', async (event, input: { channel: string; payload: unknown }) => {
    validateSender(event.senderFrame?.url ?? '')
    if (!RUNTIME_CHANNELS.has(input.channel)) throw new Error('Kênh nghiệp vụ không được phép.')
    if (input.channel === 'director:message') {
      const message = input.payload as { bookId?: unknown; content?: unknown }
      const preferredKind = await vault.getPreferredKind()
      const provider = preferredKind ? await vault.reveal(preferredKind) : null
      return requireRuntime().invoke(input.channel, {
        bookId: String(message.bookId ?? ''),
        content: String(message.content ?? ''),
        providerSecret: provider ? {
          kind: provider.kind,
          apiKey: provider.apiKey,
          endpoint: provider.endpoint,
          model: provider.model
        } : null
      })
    }
    if (input.channel === 'workflow:start') {
      const providerRoutes = await resolveWorkflowRoutes()
      return requireRuntime().invoke(input.channel, {
        ...(input.payload && typeof input.payload === 'object' ? input.payload : {}),
        providerRoutes
      })
    }
    if (input.channel === 'workflow:resume' || input.channel === 'workflow:retry') {
      const runId = String((input.payload as { runId?: unknown } | null)?.runId ?? '')
      const requirements = await requireRuntime().invoke<ProviderRoute[]>('workflow:requirements', { runId })
      const providerRoutes = await resolveWorkflowRoutes(requirements)
      return requireRuntime().invoke(input.channel, {
        ...(input.payload && typeof input.payload === 'object' ? input.payload : {}),
        providerRoutes
      })
    }
    return requireRuntime().invoke(input.channel, input.payload)
  })

  ipcMain.handle('vault:list', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    return vault.list()
  })
  ipcMain.handle('vault:save', async (event, input: ProviderConnectionInput) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    return vault.save(input)
  })
  ipcMain.handle('vault:remove', async (event, kind: Exclude<ProviderKind, 'demo'>) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    await vault.remove(kind)
  })
  ipcMain.handle('vault:test', async (event, kind: Exclude<ProviderKind, 'demo'>) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    const secret = await vault.reveal(kind)
    if (!secret) throw new Error('Provider chưa được cấu hình.')
    return requireRuntime().invoke('provider:test', secret)
  })
  ipcMain.handle('vault:preferred', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    return vault.getPreferredKind()
  })
  ipcMain.handle('vault:set-preferred', async (event, kind: Exclude<ProviderKind, 'demo'>) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    await vault.setPreferredKind(kind)
  })
  ipcMain.handle('vault:routing', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    return vault.listRoleRoutes()
  })
  ipcMain.handle('vault:set-route', async (event, route: ProviderRoute) => {
    validateSender(event.senderFrame?.url ?? '')
    requireRuntime()
    return vault.setRoleRoute(route)
  })
  ipcMain.handle('backup:create', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Tạo bản sao lưu',
      defaultPath: `novel-agent-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }]
    })
    if (result.canceled || !result.filePath) return null
    const backupResult = await requireRuntime().invoke<{ pages: number; integrity: string }>('backup:create', { destination: result.filePath })
    const inspection = recovery.inspectBackup(result.filePath)
    return { ...backupResult, inspection }
  })
  ipcMain.handle('backup:restore', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Chọn SQLite backup để khôi phục',
      properties: ['openFile'],
      filters: [{ name: 'SQLite backup', extensions: ['sqlite', 'db'] }]
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    const sourcePath = selection.filePaths[0]
    const inspection = recovery.inspectBackup(sourcePath)
    if (!await confirmRestore(inspection, 'SQLite backup')) return null
    return applyDatabaseRestore(sourcePath, inspection)
  })
  ipcMain.handle('archive:export', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Xuất project archive',
      defaultPath: `novel-agent-project-${new Date().toISOString().slice(0, 10)}.novelproj`,
      filters: [{ name: 'Novel Agent project', extensions: ['novelproj'] }]
    })
    if (result.canceled || !result.filePath) return null
    const snapshotPath = recovery.temporarySnapshotPath()
    try {
      await requireRuntime().invoke('backup:create', { destination: snapshotPath })
      return await recovery.createProjectArchive(snapshotPath, result.filePath)
    } finally {
      await rm(snapshotPath, { force: true })
    }
  })
  ipcMain.handle('archive:import', async (event) => {
    validateSender(event.senderFrame?.url ?? '')
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Chọn project archive để nhập',
      properties: ['openFile'],
      filters: [{ name: 'Novel Agent project', extensions: ['novelproj'] }]
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    const prepared = await recovery.prepareProjectArchive(selection.filePaths[0])
    try {
      if (!await confirmRestore(prepared.inspection, 'Project archive')) return null
      return await applyDatabaseRestore(prepared.sourcePath, prepared.inspection)
    } finally {
      await prepared.cleanup()
    }
  })
  ipcMain.handle('recovery:status', (event) => {
    validateSender(event.senderFrame?.url ?? '')
    return recovery.getStatus()
  })
  ipcMain.handle('recovery:restart', (event) => {
    validateSender(event.senderFrame?.url ?? '')
    scheduleRelaunch()
  })
  ipcMain.handle('export:book', async (event, format: ExportFormat) => {
    validateSender(event.senderFrame?.url ?? '')
    const snapshot = await requireRuntime().invoke<BootstrapSnapshot>('app:bootstrap')
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Xuất bản thảo',
      defaultPath: suggestFileName(snapshot.activeBook.title, format),
      filters: [{ name: format.toUpperCase(), extensions: [format === 'markdown' ? 'md' : format] }]
    })
    if (result.canceled || !result.filePath) return null
    await exportBook(snapshot, result.filePath, format)
    return { path: result.filePath }
  })
}

function requireRuntime(): RuntimeBridge {
  if (!runtime) throw new Error('Ứng dụng đang ở SQLite Safe Mode. Chỉ các thao tác khôi phục dữ liệu được phép.')
  return runtime
}

/**
 * Tạo RuntimeBridge có xử lý crash-loop: khi runtime chết quá ngưỡng trong một
 * cửa sổ thời gian, ta ghi nhận lý do vào recovery và đưa ứng dụng vào Safe Mode
 * thay vì fork lại im lặng mãi.
 */
function createRuntimeBridge(dataDirectory: string): RuntimeBridge {
  return new RuntimeBridge(dataDirectory, (reason) => {
    console.error(`[runtime-fatal] ${sanitizeDiagnostic(reason.message)}`)
    recovery.markFailure('runtime_startup', reason.message)
    runtime = null
    mainWindow?.webContents.send('runtime:fatal', { message: reason.message, restarts: reason.restarts })
  })
}

async function confirmRestore(inspection: BackupInspection, sourceLabel: string): Promise<boolean> {
  const result = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    title: 'Xác nhận thay toàn bộ workspace',
    message: `Khôi phục từ ${sourceLabel}?`,
    detail: [
      `Schema v${inspection.schemaVersion} · ${inspection.seriesCount} series · ${inspection.bookCount} sách · ${inspection.chapterCount} chương.`,
      'Workspace hiện tại sẽ được lưu thành recovery point trước khi thay thế.',
      'API key không nằm trong backup hoặc project archive.'
    ].join('\n'),
    buttons: ['Hủy', 'Khôi phục và khởi động lại'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}

async function applyDatabaseRestore(sourcePath: string, inspection: BackupInspection): Promise<RecoveryActionResult> {
  const previousRuntime = runtime
  runtime = null
  await previousRuntime?.stop()
  try {
    const result = await recovery.replaceDatabase(sourcePath, inspection)
    scheduleRelaunch()
    return result
  } catch (error) {
    try {
      const status = recovery.getStatus()
      if (!status.safeMode) {
        runtime = createRuntimeBridge(recovery.dataDirectory)
        await runtime.start()
      }
    } catch (restartError) {
      runtime = null
      recovery.markFailure('restore_failed', restartError instanceof Error ? restartError.message : 'Không thể mở lại runtime sau lỗi restore.')
    }
    throw error
  }
}

function scheduleRelaunch(): void {
  setTimeout(() => {
    app.relaunch()
    app.exit(0)
  }, 350)
}

async function resolveWorkflowRoutes(requirements?: ProviderRoute[]): Promise<WorkflowProviderRouteSecret[]> {
  const routes = requirements ?? await vault.listRoleRoutes()
  return Promise.all(routes.map(async (route) => {
    if (route.provider === 'demo') return { ...route }
    const connection = await vault.reveal(route.provider)
    if (!connection) throw new Error(`Provider ${route.provider} chưa được cấu hình cho vai trò ${route.roleId}.`)
    return {
      ...route,
      apiKey: connection.apiKey,
      endpoint: connection.endpoint
    }
  }))
}

function validateSender(url: string): void {
  const valid = url.startsWith('novel-agent://app') || (!app.isPackaged && url.startsWith('http://localhost:'))
  if (!valid) throw new Error('Nguồn IPC không hợp lệ.')
}

function isSafeExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function sanitizeDiagnostic(value: string, maxLength = 500): string {
  return value
    .replace(/(api[_-]?key|authorization|bearer|token|secret|password)(\s*[:=]\s*|\s+)[^\s,;]+/gi, '$1=[đã ẩn]')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength)
}
