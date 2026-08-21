import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  const updaterEvents = {
    on(event: string, listener: (...args: any[]) => void): void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event: string, ...args: any[]): void {
      listeners.get(event)?.forEach((listener) => listener(...args))
    },
    removeAllListeners(): void {
      listeners.clear()
    }
  }
  return {
    updaterEvents,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    showMessageBox: vi.fn(),
    app: {
      isPackaged: true,
      getVersion: () => '0.1.7'
    }
  }
})

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: Object.assign(mocks.updaterEvents, {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      logger: null,
      checkForUpdates: mocks.checkForUpdates,
      downloadUpdate: mocks.downloadUpdate,
      quitAndInstall: mocks.quitAndInstall
    })
  }
}))

vi.mock('electron', () => ({ app: mocks.app, dialog: { showMessageBox: mocks.showMessageBox } }))

import { AppUpdater } from '../apps/desktop/src/main/updater'

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}

function windowMock() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}

describe('AppUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.app.isPackaged = true
    mocks.checkForUpdates.mockReset()
    mocks.downloadUpdate.mockReset()
    mocks.quitAndInstall.mockReset()
    mocks.showMessageBox.mockReset()
    mocks.updaterEvents.removeAllListeners()
    mocks.checkForUpdates.mockResolvedValue({ updateInfo: undefined })
    mocks.downloadUpdate.mockResolvedValue([])
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('kiểm tra sau delay và lặp lại theo interval', async () => {
    const updater = new AppUpdater(logger() as never)
    updater.attach(windowMock() as never, async () => false)
    updater.startAutoCheck(1_000, 2_000)

    await vi.advanceTimersByTimeAsync(999)
    expect(mocks.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await Promise.resolve()
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(2)
    updater.dispose()
  })

  it('chọn để sau sẽ dừng auto-check trong phiên', async () => {
    const updater = new AppUpdater(logger() as never)
    updater.attach(windowMock() as never, async () => false)
    updater.startAutoCheck(1, 10)
    mocks.checkForUpdates.mockImplementation(async () => {
      mocks.updaterEvents.emit('update-available', { version: '0.1.8', releaseNotes: 'Sửa lỗi' })
      return { updateInfo: { version: '0.1.8' } }
    })
    mocks.showMessageBox.mockResolvedValue({ response: 0 })

    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.getState()).toEqual({
      status: 'deferred',
      message: 'Đã hoãn cập nhật cho đến lần mở ứng dụng tiếp theo.'
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.checkForUpdates).toHaveBeenCalledTimes(1)
    updater.dispose()
  })

  it('cập nhật ngay sẽ tải xong rồi tự cài và khởi động lại', async () => {
    const updater = new AppUpdater(logger() as never)
    updater.attach(windowMock() as never, async () => false)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    mocks.checkForUpdates.mockImplementation(async () => {
      mocks.updaterEvents.emit('update-available', { version: '0.1.8', releaseNotes: null })
      return { updateInfo: { version: '0.1.8' } }
    })
    mocks.downloadUpdate.mockImplementation(async () => {
      mocks.updaterEvents.emit('update-downloaded', { version: '0.1.8', downloadedFile: 'C:/Temp/update.exe' })
      return ['C:/Temp/update.exe']
    })

    updater.startAutoCheck(1, 10)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(mocks.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(updater.getState()).toEqual({ status: 'installing', version: '0.1.8' })
  })
})
