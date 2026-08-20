import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Logger cục bộ cho main process.
 *
 * Ứng dụng là local-first nên log không bao giờ rời khỏi máy: chỉ ghi file trong
 * userData để người dùng tự gửi khi cần hỗ trợ. Trước đây mọi thứ chỉ đi ra
 * console, mà bản đóng gói không giữ console ở đâu cả, nên khi user gặp lỗi thì
 * không còn dấu vết nào để chẩn đoán.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Kích thước tối đa một file log trước khi xoay vòng. */
const MAX_BYTES = 2 * 1024 * 1024
/** Số file log cũ được giữ lại. */
const MAX_FILES = 5

const SECRET_RULES: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
  {
    // Cặp khoá/giá trị. Phải ăn cả tiền tố `Bearer` để giá trị thật không lọt lại
    // phía sau, và chấp nhận cả dạng JSON có dấu ngoặc kép quanh tên khoá.
    pattern: /"?(api[_-]?key|x-api-key|authorization|token|secret|password)"?(\s*[:=]\s*|\s+)"?(bearer\s+)?[^\s,;"'}]+"?/gi,
    replace: (_match, key) => `${key}=[đã ẩn]`
  },
  {
    // Khoá đứng một mình theo tiền tố phổ biến của provider BYOK.
    pattern: /\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/g,
    replace: () => '[đã ẩn]'
  }
]

/** Che các chuỗi trông giống khoá bí mật trước khi ghi ra đĩa. */
export function redact(value: string): string {
  return SECRET_RULES.reduce((message, rule) => message.replace(rule.pattern, rule.replace as never), value)
}

export class Logger {
  private readonly file: string
  private failed = false

  constructor(
    private readonly directory: string,
    private readonly minimumLevel: LogLevel = 'info'
  ) {
    this.file = join(directory, 'main.log')
  }

  get path(): string {
    return this.file
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context)
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context)
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context)
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context)
  }

  write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minimumLevel]) return
    const line = formatLine(level, message, context)
    // Log không bao giờ được làm sập ứng dụng: nếu đĩa đầy hoặc bị chặn quyền,
    // ta chỉ báo một lần ra console rồi tiếp tục chạy.
    try {
      mkdirSync(this.directory, { recursive: true })
      this.rotateIfNeeded()
      appendFileSync(this.file, line, 'utf8')
      this.failed = false
    } catch (error) {
      if (!this.failed) {
        this.failed = true
        console.error(`[logger] Không ghi được log: ${error instanceof Error ? error.message : 'lỗi không xác định'}`)
      }
    }
    if (level === 'error' || level === 'warn') console.error(line.trimEnd())
    else console.info(line.trimEnd())
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.file) || statSync(this.file).size < MAX_BYTES) return
    for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
      const source = join(this.directory, `main.${index}.log`)
      if (existsSync(source)) renameSync(source, join(this.directory, `main.${index + 1}.log`))
    }
    renameSync(this.file, join(this.directory, 'main.1.log'))
    for (const name of readdirSync(this.directory)) {
      const match = /^main\.(\d+)\.log$/.exec(name)
      if (match && Number(match[1]) > MAX_FILES) rmSync(join(this.directory, name), { force: true })
    }
  }
}

function formatLine(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), redact(message)]
  if (context && Object.keys(context).length > 0) {
    parts.push(redact(safeStringify(context)))
  }
  return `${parts.join(' ')}\n`
}

function safeStringify(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context)
  } catch {
    return '[context không thể tuần tự hoá]'
  }
}
