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

import { exportBook } from '../apps/desktop/src/main/exporters'
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
})
