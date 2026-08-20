import updaterPackage from 'electron-updater'
import { app, dialog, type BrowserWindow } from 'electron'
import type { UpdateState } from '@core/index'
import type { Logger } from './logger'

// electron-updater phát hành dưới dạng CommonJS. Khi main process được bundle thành
// ESM, named import sẽ lỗi ngay lúc khởi động trên bản đã cài.
const { autoUpdater } = updaterPackage

/**
 * Auto-update qua GitHub Releases.
 *
 * Người dùng luôn được hỏi trước khi tải và trước khi cài: bản thảo đang mở có
 * autosave, nhưng khởi động lại đột ngột giữa lúc viết vẫn là mất ngữ cảnh. Vì
 * vậy không bật autoDownload và không tự cài khi đang có việc chạy.
 */

export class AppUpdater {
  private state: UpdateState = { status: 'idle' }
  private window: BrowserWindow | null = null
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
  }

  getState(): UpdateState {
    return this.state
  }

  /**
   * Bản chạy từ nguồn hoặc chưa đóng gói không có metadata cập nhật, nên bỏ qua
   * thay vì báo lỗi cho người dùng.
   */
  private get supported(): boolean {
    return app.isPackaged
  }

  async check(options: { silent: boolean } = { silent: false }): Promise<UpdateState> {
    if (!this.supported) {
      this.publish({ status: 'unsupported', message: 'Kiểm tra cập nhật chỉ hoạt động trên bản đã đóng gói.' })
      return this.state
    }
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
    if (!this.supported) return this.state
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

  /**
   * Cài và khởi động lại. Nếu còn workflow đang chạy, hỏi lại để người dùng chủ
   * động chọn, vì khởi động lại sẽ đánh dấu workflow là gián đoạn.
   */
  async installAndRestart(): Promise<void> {
    if (this.state.status !== 'downloaded') return
    const busy = this.busyCheck ? await this.busyCheck().catch(() => false) : false
    if (busy) {
      const confirmation = await dialog.showMessageBox(this.window ?? undefined as never, {
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
    this.logger.info('Cài bản cập nhật và khởi động lại', { version: this.state.version })
    // isSilent = false để người dùng thấy tiến trình cài; isForceRunAfter = true
    // để mở lại ứng dụng sau khi cài xong.
    autoUpdater.quitAndInstall(false, true)
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
      this.publish({ status: 'downloading', version, percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.logger.info('Đã tải xong bản cập nhật', { version: info.version })
      this.publish({ status: 'downloaded', version: info.version })
    })
    autoUpdater.on('error', (error) => {
      const message = error instanceof Error ? error.message : 'Cập nhật gặp lỗi không xác định.'
      this.logger.error('Lỗi trong luồng cập nhật', { message })
      this.publish({ status: 'error', message })
    })
  }

  private publish(state: UpdateState): void {
    this.state = state
    this.window?.webContents.send('updater:state', state)
  }
}
