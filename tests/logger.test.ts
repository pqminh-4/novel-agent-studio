import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Logger, redact } from '../apps/desktop/src/main/logger'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function logDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'novel-agent-logs-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('logger cục bộ', () => {
  it('ghi log ra file với mức và ngữ cảnh', () => {
    const directory = logDirectory()
    const logger = new Logger(directory, 'info')
    logger.info('Ứng dụng khởi động', { version: '0.1.5' })
    logger.error('Có lỗi', { code: 3 })

    const content = readFileSync(logger.path, 'utf8')
    expect(content).toContain('INFO')
    expect(content).toContain('Ứng dụng khởi động')
    expect(content).toContain('"version":"0.1.5"')
    expect(content).toContain('ERROR')
    expect(content).toContain('"code":3')
  })

  it('bỏ qua log dưới mức tối thiểu', () => {
    const directory = logDirectory()
    const logger = new Logger(directory, 'warn')
    logger.debug('không được ghi')
    logger.info('cũng không được ghi')
    logger.warn('phải được ghi')

    const content = readFileSync(logger.path, 'utf8')
    expect(content).not.toContain('không được ghi')
    expect(content).not.toContain('cũng không được ghi')
    expect(content).toContain('phải được ghi')
  })

  it('che khóa bí mật trước khi ghi ra đĩa', () => {
    const directory = logDirectory()
    const logger = new Logger(directory, 'info')
    const key = 'sk-abcdef1234567890abcdef'
    logger.error('Provider từ chối', { authorization: `Bearer ${key}`, note: `api_key=${key}` })

    const content = readFileSync(logger.path, 'utf8')
    expect(content).not.toContain(key)
    expect(content).toContain('[đã ẩn]')
  })

  it('xoay vòng file khi vượt kích thước tối đa và giữ số bản giới hạn', () => {
    const directory = logDirectory()
    const logger = new Logger(directory, 'info')
    // Ghi sẵn một file vượt ngưỡng 2 MB để lần ghi tiếp theo phải xoay vòng.
    writeFileSync(logger.path, 'x'.repeat(2 * 1024 * 1024 + 10), 'utf8')
    logger.info('dòng sau khi xoay vòng')

    expect(existsSync(join(directory, 'main.1.log'))).toBe(true)
    expect(readFileSync(logger.path, 'utf8')).toContain('dòng sau khi xoay vòng')

    for (let round = 0; round < 8; round += 1) {
      writeFileSync(logger.path, 'x'.repeat(2 * 1024 * 1024 + 10), 'utf8')
      logger.info(`vòng ${round}`)
    }
    const rotated = readdirSync(directory).filter((name) => /^main\.\d+\.log$/.test(name))
    expect(rotated.length).toBeLessThanOrEqual(5)
  })

  it('không throw khi không ghi được log', () => {
    // Đường dẫn không hợp lệ: logger phải chịu lỗi im lặng, không làm sập app.
    const logger = new Logger(join('\0invalid', 'logs'), 'info')
    expect(() => logger.info('vẫn phải chạy tiếp')).not.toThrow()
  })
})

describe('redact', () => {
  it('che các dạng khóa phổ biến', () => {
    expect(redact('authorization: Bearer sk-1234567890abcdef')).not.toContain('sk-1234567890abcdef')
    expect(redact('x-api-key=AIzaSyABCDEFGH12345678')).not.toContain('AIzaSyABCDEFGH12345678')
    expect(redact('token: abc123456789')).toContain('[đã ẩn]')
  })

  it('giữ nguyên văn bản không chứa bí mật', () => {
    expect(redact('Chương 3 đã lưu thành công')).toBe('Chương 3 đã lưu thành công')
  })
})
