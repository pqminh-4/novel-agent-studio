import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { utilityProcess, type UtilityProcess } from 'electron'
import { RuntimeResponseSchema } from '@core/index'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeout: NodeJS.Timeout
}

export class RuntimeBridge {
  private child: UtilityProcess | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readyPromise: Promise<void> | null = null

  constructor(private readonly dataDirectory: string) {}

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = new Promise((resolve, reject) => {
      const modulePath = join(__dirname, 'runtime.js')
      mkdirSync(this.dataDirectory, { recursive: true })
      const child = utilityProcess.fork(modulePath, [], {
        cwd: this.dataDirectory,
        env: {
          ...process.env,
          NOVEL_AGENT_DATA_DIRECTORY: this.dataDirectory
        },
        serviceName: 'Novel Agent Application Runtime',
        stdio: 'pipe'
      })
      this.child = child

      let startupSettled = false
      const finishStartup = (error?: Error): void => {
        if (startupSettled) return
        startupSettled = true
        clearTimeout(startupTimeout)
        if (error) reject(error)
        else resolve()
      }
      const startupTimeout = setTimeout(() => finishStartup(new Error('Application Runtime khởi động quá thời gian cho phép.')), 15_000)
      child.on('message', (message) => {
        if (isReadyEvent(message)) {
          finishStartup()
          return
        }
        this.handleResponse(message)
      })
      child.on('exit', (code) => {
        const error = new Error(`Application Runtime đã dừng với mã ${code}.`)
        finishStartup(error)
        this.rejectAll(error)
        this.child = null
        this.readyPromise = null
      })
      child.on('spawn', () => {
        child.stdout?.on('data', (chunk) => console.info(`[runtime] ${String(chunk).trim()}`))
        child.stderr?.on('data', (chunk) => console.error(`[runtime] ${String(chunk).trim()}`))
      })
    })
    return this.readyPromise
  }

  async invoke<T = unknown>(channel: string, payload: unknown = {}): Promise<T> {
    await this.start()
    if (!this.child) throw new Error('Application Runtime chưa sẵn sàng.')
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Tác vụ ${channel} đã vượt quá thời gian chờ.`))
      }, 120_000)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      })
      this.child?.postMessage({ id, channel, payload })
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) {
      this.readyPromise = null
      return
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      await Promise.race([
        this.invoke('system:shutdown'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime không xác nhận đóng SQLite.')), 5_000))
      ])
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_500))])
    } catch (error) {
      console.error(`[runtime-stop] ${error instanceof Error ? error.message : 'Không thể đóng runtime sạch.'}`)
    }
    if (this.child === child) child.kill()
    this.child = null
    this.readyPromise = null
    this.rejectAll(new Error('Application Runtime đã được đóng.'))
  }

  private handleResponse(message: unknown): void {
    const parsed = RuntimeResponseSchema.safeParse(message)
    if (!parsed.success) return
    const response = parsed.data
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    if (response.ok) pending.resolve(response.data)
    else pending.reject(new Error(response.error ?? 'Application Runtime không thể hoàn tất tác vụ.'))
  }

  private rejectAll(error: Error): void {
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout)
      pending.reject(error)
    })
    this.pending.clear()
  }
}

function isReadyEvent(value: unknown): value is { type: 'runtime:ready' } {
  return Boolean(value && typeof value === 'object' && 'type' in value && value.type === 'runtime:ready')
}
