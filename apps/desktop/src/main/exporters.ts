import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { BrowserWindow } from 'electron'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import JSZip from 'jszip'
import type { BootstrapSnapshot, Chapter } from '@core/index'

export type ExportFormat = 'markdown' | 'docx' | 'epub' | 'pdf'

export async function exportBook(snapshot: BootstrapSnapshot, destination: string, format: ExportFormat): Promise<void> {
  switch (format) {
    case 'markdown':
      await writeFile(destination, toMarkdown(snapshot), 'utf8')
      return
    case 'docx':
      await writeFile(destination, await toDocx(snapshot))
      return
    case 'epub':
      await writeFile(destination, await toEpub(snapshot))
      return
    case 'pdf':
      await writeFile(destination, await toPdf(snapshot))
  }
}

function toMarkdown(snapshot: BootstrapSnapshot): string {
  const chapters = snapshot.chapters.map((chapter) => `# Chương ${chapter.number}: ${chapter.title}\n\n${chapterText(chapter)}`).join('\n\n---\n\n')
  return `---\ntitle: "${snapshot.activeBook.title}"\nseries: "${snapshot.series[0]?.name ?? ''}"\n---\n\n${chapters}\n`
}

async function toDocx(snapshot: BootstrapSnapshot): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: snapshot.activeBook.title, heading: HeadingLevel.TITLE }),
    new Paragraph({ text: snapshot.series[0]?.name ?? '', style: 'Subtitle' })
  ]
  snapshot.chapters.forEach((chapter) => {
    children.push(new Paragraph({ text: `Chương ${chapter.number}: ${chapter.title}`, heading: HeadingLevel.HEADING_1, pageBreakBefore: true }))
    splitParagraphs(chapterText(chapter)).forEach((text) => children.push(new Paragraph({ children: [new TextRun(text)] })))
  })
  const document = new Document({ sections: [{ properties: {}, children }] })
  return Packer.toBuffer(document)
}

async function toEpub(snapshot: BootstrapSnapshot): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  const manifest: string[] = []
  const spine: string[] = []
  const navigation: string[] = []
  snapshot.chapters.forEach((chapter) => {
    const id = `chapter-${chapter.number}`
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
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${escapeXml(snapshot.activeBook.title)}</title><style>@page{size:A5;margin:18mm 16mm}body{font-family:Georgia,serif;color:#181512;line-height:1.7}header{height:80vh;display:flex;flex-direction:column;justify-content:center;text-align:center}h1{page-break-before:always;font-size:22px}header h1{page-break-before:avoid;font-size:36px}p{text-align:justify;text-indent:1.5em;margin:.5em 0}</style></head><body><header><h1>${escapeXml(snapshot.activeBook.title)}</h1><p>${escapeXml(snapshot.series[0]?.name ?? '')}</p></header>${chapters}</body></html>`
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await window.webContents.printToPDF({ pageSize: 'A5', printBackground: true, margins: { top: 0.6, bottom: 0.6, left: 0.55, right: 0.55 } })
  } finally {
    window.destroy()
  }
}

export function suggestFileName(title: string, format: ExportFormat): string {
  const safe = basename(title).replace(/[<>:"/\\|?*]/g, '-').trim() || 'ban-thao'
  return `${safe}.${format === 'markdown' ? 'md' : format}`
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
