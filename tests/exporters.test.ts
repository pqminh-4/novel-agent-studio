import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      printToPDF: async (): Promise<Buffer> => Buffer.from('%PDF-1.7\n% Novel Agent Studio\n')
    }

    async loadURL(): Promise<void> {}

    destroy(): void {}
  }
}))

import { exportBook, exportBookFormats, suggestFileName } from '../apps/desktop/src/main/exporters'
import { NovelDatabase } from '@infra/index'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

describe('xuất bản thảo', () => {
  it('tạo được Markdown, DOCX, EPUB và PDF', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-export-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(join(directory, 'data'))
    const snapshot = database.getBootstrapSnapshot()
    database.close()

    const markdownPath = join(directory, 'book.md')
    const docxPath = join(directory, 'book.docx')
    const epubPath = join(directory, 'book.epub')
    const pdfPath = join(directory, 'book.pdf')
    await exportBook(snapshot, markdownPath, 'markdown')
    await exportBook(snapshot, docxPath, 'docx')
    await exportBook(snapshot, epubPath, 'epub')
    await exportBook(snapshot, pdfPath, 'pdf')

    expect(readFileSync(markdownPath, 'utf8')).toContain('Thành phố không tên')

    const docx = await JSZip.loadAsync(readFileSync(docxPath))
    expect(await docx.file('word/document.xml')?.async('string')).toContain('Ngọn đèn tắt')

    const epub = await JSZip.loadAsync(readFileSync(epubPath))
    expect(await epub.file('mimetype')?.async('string')).toBe('application/epub+zip')
    expect(await epub.file('OEBPS/content.opf')?.async('string')).toContain('Thành phố không tên')

    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF')
  })

  it('xuất tập chương tùy chọn theo đúng thứ tự', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-custom-export-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(join(directory, 'data'))
    const snapshot = database.getBootstrapSnapshot()
    database.close()
    expect(snapshot.chapters.length).toBeGreaterThanOrEqual(2)

    const selected = [snapshot.chapters[1].id, snapshot.chapters[0].id]
    const result = await exportBookFormats(snapshot, directory, ['markdown', 'epub'], selected)
    expect(result.failed).toEqual([])
    expect(result.exported).toHaveLength(2)

    const markdown = readFileSync(result.exported.find((item) => item.format === 'markdown')!.path, 'utf8')
    expect(markdown.indexOf(snapshot.chapters[1].title)).toBeLessThan(markdown.indexOf(snapshot.chapters[0].title))
    const epub = await JSZip.loadAsync(readFileSync(result.exported.find((item) => item.format === 'epub')!.path))
    const navigation = await epub.file('OEBPS/nav.xhtml')!.async('string')
    expect(navigation.indexOf(snapshot.chapters[1].title)).toBeLessThan(navigation.indexOf(snapshot.chapters[0].title))
  })

  it('từ chối danh sách chương rỗng, trùng hoặc không thuộc sách', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-invalid-export-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(join(directory, 'data'))
    const snapshot = database.getBootstrapSnapshot()
    database.close()
    const destination = join(directory, 'book.md')

    await expect(exportBook(snapshot, destination, 'markdown', [])).rejects.toThrow('ít nhất một chương')
    await expect(exportBook(snapshot, destination, 'markdown', [snapshot.chapters[0].id, snapshot.chapters[0].id])).rejects.toThrow('trùng lặp')
    await expect(exportBook(snapshot, destination, 'markdown', ['chapter-does-not-exist'])).rejects.toThrow('không thuộc sách')
  })

  it('tạo tên tệp an toàn và từ chối danh sách định dạng rỗng', async () => {
    expect(suggestFileName('../Tên:Sách?.doc', 'docx')).toBe('Tên-Sách-.doc.docx')
    const directory = mkdtempSync(join(tmpdir(), 'novel-agent-formats-export-'))
    temporaryDirectories.push(directory)
    const database = new NovelDatabase(join(directory, 'data'))
    const snapshot = database.getBootstrapSnapshot()
    database.close()
    await expect(exportBookFormats(snapshot, directory, [])).rejects.toThrow('ít nhất một định dạng')
  })
})
