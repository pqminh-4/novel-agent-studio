import updaterPackage from 'electron-updater'
import { app, dialog, type BrowserWindow } from 'electron'
import type { UpdateState } from '@core/index'
import type { Logger } from './logger'

// electron-updater phát hành dưới dạng CommonJS. Khi main process được bundle thành
// ESM, named import sẽ lỗi ngay lúc khởi động trên bản đã cài.
const { autoUpdater } = updaterPackage

export const DEFAULT_INITIAL_CHECK_DELAY_MS = 4_000
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

/**
 * Auto-update qua GitHub Releases.
 *
 * Main process sở hữu timer và quyết định cập nhật để renderer reload hoặc đổi
 * workspace không thể tạo nhiều prompt/download đồng thời. Installer vẫn do
 * electron-updater và NSIS quản lý.
 */
export class AppUpdater {
  private state: UpdateState = { status: 'idle' }
  private window: BrowserWindow | null = null
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null
  private autoCheckStarted = false
  private deferredThisSession = false
  private quitting = false
  private checkPromise: Promise<UpdateState> | null = null
  private downloadPromise: Promise<UpdateState> | null = null
  private installPromise: Promise<void> | null = null
  private approvedVersion: string | null = null
  private installStarted = false
  /** Trả về true khi có workflow AI đang chạy, để hoãn việc khởi động lại. */
  private busyCheck: (() => Promise<boolean>) | null = null

  constructor(private readonly logger: Logger) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = {
      info: (message: unknown) => this.logger.info('updater', { message: String(message) }),
      warn: (message: unknown) => this.logger.warn('updater', { message: String(message) }),
      error: (message: unknown) => this.logger.error('updater', { message: String(message) }),
      debug: (message: unknown) => this.logger.debug('updater', { message: String(message) })
    }
    this.registerEvents()
  }

  attach(window: BrowserWindow, busyCheck: () => Promise<boolean>): void {
    this.window = window
    this.busyCheck = busyCheck
    this.publish(this.state)
  }

  getState(): UpdateState {
    return this.state
  }

  startAutoCheck(
    initialDelayMs = DEFAULT_INITIAL_CHECK_DELAY_MS,
    intervalMs = DEFAULT_CHECK_INTERVAL_MS
  ): void {
    if (this.autoCheckStarted || this.quitting || this.deferredThisSession) return
    this.autoCheckStarted = true
    this.scheduleAutoCheck(initialDelayMs, intervalMs)
  }

  stopAutoCheck(): void {
    if (this.autoCheckTimer) clearTimeout(this.autoCheckTimer)
    this.autoCheckTimer = null
    this.autoCheckStarted = false
  }

  deferForSession(): void {
    this.deferredThisSession = true
    this.stopAutoCheck()
    if (this.state.status === 'available') {
      this.publish({ status: 'deferred', message: 'Đã hoãn cập nhật cho đến lần mở ứng dụng tiếp theo.' })
    }
    this.logger.info('Người dùng đã hoãn cập nhật trong phiên hiện tại')
  }

  dispose(): void {
    this.quitting = true
    this.stopAutoCheck()
  }

  /** Bản chạy từ nguồn không có metadata cập nhật nên chỉ báo unsupported. */
  private get supported(): boolean {
    return app.isPackaged
  }

  async check(options: { silent: boolean } = { silent: false }): Promise<UpdateState> {
    if (!this.supported) {
      this.publish({ status: 'unsupported', message: 'Kiểm tra cập nhật chỉ hoạt động trên bản đã đóng gói.' })
      return this.state
    }
    if (this.quitting) return this.state
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = this.performCheck(options).finally(() => {
      this.checkPromise = null
    })
    return this.checkPromise
  }

  private async performCheck(options: { silent: boolean }): Promise<UpdateState> {
    this.publish({ status: 'checking' })
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result || !result.updateInfo) {
        this.publish({ status: 'current', version: app.getVersion() })
      }
      return this.state
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể kiểm tra cập nhật.'
      this.logger.warn('Kiểm tra cập nhật thất bại', { message, silent: options.silent })
      this.publish({ status: 'error', message })
      return this.state
    }
  }

  async download(): Promise<UpdateState> {
    if (!this.supported || this.quitting) return this.state
    if (this.downloadPromise) return this.downloadPromise
    if (this.state.status !== 'available') return this.state
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = null
    })
    return this.downloadPromise
  }

  private async performDownload(): Promise<UpdateState> {
    try {
      await autoUpdater.downloadUpdate()
      return this.state
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể tải bản cập nhật.'
      this.logger.error('Tải bản cập nhật thất bại', { message })
      this.publish({ status: 'error', message })
      return this.state
    }
  }

  /** Cài sau khi download xong, hỏi lại nếu workflow đang chạy. */
  async installAndRestart(): Promise<void> {
    if (this.installPromise) return this.installPromise
    if (this.state.status !== 'downloaded' || this.quitting || this.installStarted) return
    this.installPromise = this.performInstall().finally(() => {
      this.installPromise = null
    })
    return this.installPromise
  }

  private async performInstall(): Promise<void> {
    const busy = this.busyCheck ? await this.busyCheck().catch(() => false) : false
    if (busy) {
      const confirmation = this.window
        ? await dialog.showMessageBox(this.window, {
            type: 'warning',
            title: 'Còn workflow đang chạy',
            message: 'Cài đặt cập nhật ngay?',
            detail: [
              'Một hoặc nhiều workflow AI đang chạy. Khởi động lại sẽ đánh dấu chúng là gián đoạn.',
              'Bản thảo đã autosave nên nội dung không bị mất.'
            ].join('\n'),
            buttons: ['Để sau', 'Cài và khởi động lại'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
        : await dialog.showMessageBox({
            type: 'warning',
            title: 'Còn workflow đang chạy',
            message: 'Cài đặt cập nhật ngay?',
            detail: [
              'Một hoặc nhiều workflow AI đang chạy. Khởi động lại sẽ đánh dấu chúng là gián đoạn.',
              'Bản thảo đã autosave nên nội dung không bị mất.'
            ].join('\n'),
            buttons: ['Để sau', 'Cài và khởi động lại'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
      if (confirmation.response !== 1) return
    }
    const version = this.state.status === 'downloaded' ? this.state.version : undefined
    this.installStarted = true
    this.quitting = true
    this.stopAutoCheck()
    if (version) this.publish({ status: 'installing', version })
    this.logger.info('Cài bản cập nhật và khởi động lại', { version })
    // isSilent = false để người dùng thấy tiến trình cài; isForceRunAfter = true
    // để mở lại ứng dụng sau khi cài xong.
    autoUpdater.quitAndInstall(false, true)
  }

  private scheduleAutoCheck(delayMs: number, intervalMs: number): void {
    if (!this.autoCheckStarted || this.deferredThisSession || this.quitting) return
    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null
      void this.check({ silent: true }).then(async (state) => {
        if (state.status === 'available') await this.promptForUpdate(state.version)
        if (this.autoCheckStarted && !this.deferredThisSession && !this.quitting) {
          this.scheduleAutoCheck(intervalMs, intervalMs)
        }
      }).catch((error) => {
        this.logger.warn('Auto-check cập nhật gặp lỗi ngoài dự kiến', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }, delayMs)
  }

  private async promptForUpdate(version: string): Promise<void> {
    if (this.quitting || this.deferredThisSession || this.approvedVersion === version) return
    const state = this.state
    if (state.status !== 'available' || state.version !== version) return
    const result = this.window
      ? await dialog.showMessageBox(this.window, {
          type: 'info',
          title: 'Có bản cập nhật mới',
          message: `Novel Agent Studio ${version} đã sẵn sàng.`,
          detail: state.notes
            ? `${state.notes.slice(0, 1_000)}\n\nBạn có muốn tải và cài đặt ngay không?`
            : 'Bạn có muốn tải và cài đặt ngay không?',
          buttons: ['Để sau', 'Cập nhật ngay'],
          defaultId: 1,
          cancelId: 0,
          noLink: true
        })
      : await dialog.showMessageBox({
          type: 'info',
          title: 'Có bản cập nhật mới',
          message: `Novel Agent Studio ${version} đã sẵn sàng.`,
          detail: state.notes
            ? `${state.notes.slice(0, 1_000)}\n\nBạn có muốn tải và cài đặt ngay không?`
            : 'Bạn có muốn tải và cài đặt ngay không?',
          buttons: ['Để sau', 'Cập nhật ngay'],
          defaultId: 1,
          cancelId: 0,
          noLink: true
        })
    if (result.response !== 1) {
      this.deferForSession()
      return
    }
    this.approvedVersion = version
    this.stopAutoCheck()
    await this.download()
  }

  private registerEvents(): void {
    autoUpdater.on('update-available', (info) => {
      this.logger.info('Có bản cập nhật', { version: info.version })
      this.publish({
        status: 'available',
        version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes.slice(0, 4_000) : null
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.publish({ status: 'current', version: app.getVersion() })
    })
    autoUpdater.on('download-progress', (progress) => {
      const version = this.state.status === 'available' || this.state.status === 'downloading'
        ? this.state.version
        : app.getVersion()
      this.publish({ status: 'downloading', version, percent: Math.min(100, Math.max(0, Math.round(progress.percent))) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.logger.info('Đã tải xong bản cập nhật', { version: info.version, file: info.downloadedFile })
      this.publish({ status: 'downloaded', version: info.version })
      if (this.approvedVersion === info.version) void this.installAndRestart()
    })
    autoUpdater.on('error', (error) => {
      const message = error instanceof Error ? error.message : 'Cập nhật gặp lỗi không xác định.'
      this.logger.error('Lỗi trong luồng cập nhật', { message })
      this.publish({ status: 'error', message })
    })
  }

  private publish(state: UpdateState): void {
    this.state = state
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('updater:state', state)
  }
}
