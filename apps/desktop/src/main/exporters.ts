import { writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { BrowserWindow } from 'electron'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import JSZip from 'jszip'
import type { BootstrapSnapshot, Chapter } from '@core/index'

export type ExportFormat = 'markdown' | 'docx' | 'epub' | 'pdf'
export type ExportResult = { path: string; bookId: string; format: ExportFormat }
export type ExportFailure = { bookId: string; format: ExportFormat; message: string }

const EXPORT_FORMATS = new Set<ExportFormat>(['markdown', 'docx', 'epub', 'pdf'])

export async function exportBook(
  snapshot: BootstrapSnapshot,
  destination: string,
  format: ExportFormat,
  chapterIds?: string[]
): Promise<void> {
  validateFormat(format)
  const selected = selectChapters(snapshot, chapterIds)
  const exportSnapshot = { ...snapshot, chapters: selected }
  switch (format) {
    case 'markdown':
      await writeFile(destination, toMarkdown(exportSnapshot), 'utf8')
      return
    case 'docx':
      await writeFile(destination, await toDocx(exportSnapshot))
      return
    case 'epub':
      await writeFile(destination, await toEpub(exportSnapshot))
      return
    case 'pdf':
      await writeFile(destination, await toPdf(exportSnapshot))
  }
}

export async function exportBookFormats(
  snapshot: BootstrapSnapshot,
  directory: string,
  formats: ExportFormat[],
  chapterIds?: string[],
  fileTitle = snapshot.activeBook.title
): Promise<{ exported: ExportResult[]; failed: ExportFailure[] }> {
  const uniqueFormats = validateFormats(formats)
  selectChapters(snapshot, chapterIds)
  const exported: ExportResult[] = []
  const failed: ExportFailure[] = []
  for (const format of uniqueFormats) {
    const destination = safeDestination(directory, suggestFileName(fileTitle, format))
    try {
      await exportBook(snapshot, destination, format, chapterIds)
      exported.push({ path: destination, bookId: snapshot.activeBook.id, format })
    } catch (error) {
      failed.push({
        bookId: snapshot.activeBook.id,
        format,
        message: error instanceof Error ? error.message : 'Không thể xuất bản thảo.'
      })
    }
  }
  return { exported, failed }
}

function toMarkdown(snapshot: BootstrapSnapshot): string {
  const chapters = snapshot.chapters.map((chapter) => `# Chương ${chapter.number}: ${chapter.title}\n\n${chapterText(chapter)}`).join('\n\n---\n\n')
  return `---\ntitle: "${snapshot.activeBook.title}"\nseries: "${activeSeriesName(snapshot)}"\n---\n\n${chapters}\n`
}

async function toDocx(snapshot: BootstrapSnapshot): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: snapshot.activeBook.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: activeSeriesName(snapshot), style: 'Subtitle' })
  ]
  snapshot.chapters.forEach((chapter) => {
    children.push(new Paragraph({ text: `Chương ${chapter.number}: ${chapter.title}`, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }))
    splitParagraphs(chapterText(chapter)).forEach((text) => children.push(new Paragraph({ children: [new TextRun(text)] })))
  })
  return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }))
}

async function toEpub(snapshot: BootstrapSnapshot): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  const manifest: string[] = []
  const spine: string[] = []
  const navigation: string[] = []
  snapshot.chapters.forEach((chapter, index) => {
    const id = `chapter-${index + 1}`
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="${id}"/>`)
    navigation.push(`<li><a href="${id}.xhtml">Chương ${chapter.number}: ${escapeXml(chapter.title)}</a></li>`)
    zip.file(`OEBPS/${id}.xhtml`, `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="vi"><head><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" href="style.css" type="text/css"/></head><body><h1>Chương ${chapter.number}: ${escapeXml(chapter.title)}</h1>${splitParagraphs(chapterText(chapter)).map((text) => `<p>${escapeXml(text)}</p>`).join('')}</body></html>`)
  })
  zip.file('OEBPS/style.css', 'body{font-family:serif;line-height:1.65;margin:6%;}h1{page-break-before:always;}p{text-indent:1.5em;margin:.5em 0;}')
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Mục lục</title></head><body><nav epub:type="toc"><ol>${navigation.join('')}</ol></nav></body></html>`)
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${snapshot.activeBook.id}</dc:identifier><dc:title>${escapeXml(snapshot.activeBook.title)}</dc:title><dc:language>vi</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${manifest.join('')}</manifest><spine>${spine.join('')}</spine></package>`)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

async function toPdf(snapshot: BootstrapSnapshot): Promise<Buffer> {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  const chapters = snapshot.chapters.map((chapter) => `<section><h1>Chương ${chapter.number}: ${escapeXml(chapter.title)}</h1>${splitParagraphs(chapterText(chapter)).map((text) => `<p>${escapeXml(text)}</p>`).join('')}</section>`).join('')
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${escapeXml(snapshot.activeBook.title)}</title><style>@page{size:A5;margin:18mm 16mm}body{font-family:Georgia,serif;color:#181512;line-height:1.7}header{height:80vh;display:flex;flex-direction:column;justify-content:center;text-align:center}h1{page-break-before:always;font-size:22px}header h1{page-break-before:avoid;font-size:36px}p{text-align:justify;text-indent:1.5em;margin:.5em 0}</style></head><body><header><h1>${escapeXml(snapshot.activeBook.title)}</h1><p>${escapeXml(activeSeriesName(snapshot))}</p></header>${chapters}</body></html>`
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await window.webContents.printToPDF({ pageSize: 'A5', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.55, right: 0.55 } })
  } finally {
    window.destroy()
  }
}

export function suggestFileName(title: string, format: ExportFormat): string {
  validateFormat(format)
  const safe = basename(title).replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim() || 'ban-thao'
  return `${safe}.${format === 'markdown' ? 'md' : format}`
}

export function validateFormats(formats: ExportFormat[]): ExportFormat[] {
  if (!Array.isArray(formats) || formats.length === 0 || formats.length > EXPORT_FORMATS.size) {
    throw new Error('Hãy chọn ít nhất một định dạng xuất bản.')
  }
  formats.forEach(validateFormat)
  return [...new Set(formats)]
}

function validateFormat(format: ExportFormat): void {
  if (!EXPORT_FORMATS.has(format)) throw new Error('Định dạng xuất bản không hợp lệ.')
}

function selectChapters(snapshot: BootstrapSnapshot, chapterIds?: string[]): Chapter[] {
  if (chapterIds === undefined) {
    if (snapshot.chapters.length === 0) throw new Error('Sách không có chương để xuất bản.')
    return snapshot.chapters
  }
  if (!Array.isArray(chapterIds) || chapterIds.length === 0 || chapterIds.length > 5000) {
    throw new Error('Hãy chọn ít nhất một chương để xuất bản.')
  }
  if (new Set(chapterIds).size !== chapterIds.length) throw new Error('Danh sách chương bị trùng lặp.')
  const chapters = new Map(snapshot.chapters.map((chapter) => [chapter.id, chapter]))
  return chapterIds.map((id) => {
    const chapter = chapters.get(id)
    if (!chapter || chapter.bookId !== snapshot.activeBook.id) throw new Error('Chương được chọn không thuộc sách này.')
    if (chapter.contentCorrupt) throw new Error(`Chương ${chapter.number} có nội dung bị hỏng và không thể xuất bản.`)
    return chapter
  })
}

function safeDestination(directory: string, fileName: string): string {
  const root = resolve(directory)
  const destination = resolve(join(root, fileName))
  if (destination !== root && !destination.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Đường dẫn xuất bản không hợp lệ.')
  }
  return destination
}

function activeSeriesName(snapshot: BootstrapSnapshot): string {
  return snapshot.series.find((series) => series.id === snapshot.activeBook.seriesId)?.name ?? ''
}

function chapterText(chapter: Chapter): string {
  return extractText(chapter.content)
}

function extractText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const record = node as Record<string, unknown>
  const own = typeof record.text === 'string' ? record.text : ''
  const children = Array.isArray(record.content) ? record.content.map(extractText).join(' ') : ''
  return `${own} ${children}`.replace(/\s+/g, ' ').trim()
}

function splitParagraphs(value: string): string[] {
  return value.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char)
}
