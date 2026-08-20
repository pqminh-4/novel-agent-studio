import {
  ChapterSummarySchema,
  LongContextPacketSchema,
  type BootstrapSnapshot,
  type Chapter,
  type ChapterSummary,
  type ContextSource,
  type ContinuityIssue,
  type LongContextPacket,
  type OutlineChapter,
  type StoryBrief,
  type WorkflowArtifact
} from '@core/index'

export type ChapterSummaryInput = {
  chapter: Chapter
  sourceVersion: number
  canon: BootstrapSnapshot['canon']
  now?: string
  id?: string
}

export type LongContextInput = {
  brief: StoryBrief
  outline: OutlineChapter
  chapter: Chapter
  canon: BootstrapSnapshot['canon']
  chapterSummaries: ChapterSummary[]
  previousArtifacts: WorkflowArtifact[]
  tokenBudget: number
}

export function estimateTokens(value: string): number {
  return value.trim() ? Math.max(1, Math.ceil(value.length / 4)) : 0
}

export function summarizeChapter(input: ChapterSummaryInput): ChapterSummary {
  const body = extractDocumentText(input.chapter.content)
  const sentences = splitSentences(body)
  const synopsis = input.chapter.summary.trim()
  const keyEvents = uniqueStrings(sentences.filter((sentence) => sentence.length >= 24).slice(0, 5))
  const summary = truncateText(uniqueStrings([synopsis, ...keyEvents]).join(' '), 1_400)
    || `Chương ${input.chapter.number} chưa có đủ nội dung để tạo tóm tắt.`
  const searchable = normalizeForSearch(`${input.chapter.title} ${synopsis} ${body}`)
  const characters = input.canon
    .filter((fact) => fact.category === 'character' && (fact.sourceChapter === input.chapter.number || includesPhrase(searchable, fact.subject)))
    .map((fact) => fact.subject)
  const locations = input.canon
    .filter((fact) => fact.category === 'location' && (fact.sourceChapter === input.chapter.number || includesPhrase(searchable, fact.subject)))
    .map((fact) => fact.subject)
  const unresolvedThreads = uniqueStrings(sentences.filter((sentence) => {
    const normalized = normalizeForSearch(sentence)
    return sentence.includes('?') || ['chua ro', 'bi an', 'van con', 'chua the', 'khong biet'].some((term) => normalized.includes(term))
  }).slice(0, 5))
  return ChapterSummarySchema.parse({
    id: input.id ?? `summary:${input.chapter.id}`,
    chapterId: input.chapter.id,
    bookId: input.chapter.bookId,
    chapterNumber: input.chapter.number,
    chapterTitle: input.chapter.title,
    sourceVersion: input.sourceVersion,
    summary,
    keyEvents,
    characters: uniqueStrings(characters),
    locations: uniqueStrings(locations),
    unresolvedThreads,
    tokenEstimate: estimateTokens(JSON.stringify({ summary, keyEvents, characters, locations, unresolvedThreads })),
    updatedAt: input.now ?? new Date().toISOString()
  })
}

export function buildLongContextPacket(input: LongContextInput): LongContextPacket {
  const limit = Math.max(2_000, Math.trunc(input.tokenBudget))
  const query = [
    input.chapter.title,
    input.chapter.summary,
    input.outline.title,
    input.outline.purpose,
    input.brief.premise,
    input.brief.conflict,
    ...input.brief.protagonists,
    ...input.brief.mustInclude
  ].filter(Boolean).join(' · ')
  const queryTokens = tokenSet(query)
  const eligibleSummaries = input.chapterSummaries.filter((summary) => summary.chapterNumber < input.chapter.number)
  const eligibleCanon = input.canon.filter((fact) => fact.sourceChapter === null || fact.sourceChapter < input.chapter.number)
  const futureCanon = input.canon.filter((fact) => fact.sourceChapter !== null && fact.sourceChapter >= input.chapter.number)
  const continuityIssues = detectContinuityIssues(input, eligibleSummaries, futureCanon)
  const fixedSources: ContextSource[] = [
    createSource('brief', 'author-brief:latest', 'Brief tác giả', JSON.stringify(input.brief), 10_000, 'author-brief:latest'),
    createSource('outline', `outline:chapter-${input.outline.number}`, `Dàn ý chương ${input.outline.number}`, JSON.stringify(input.outline), 9_000, `outline:chapter-${input.outline.number}`)
  ]
  const artifactSources = input.previousArtifacts.map((artifact, index) => createSource(
    'workflow_artifact',
    artifact.id,
    `${artifact.kind} · ${artifact.title}`,
    JSON.stringify({ title: artifact.title, summary: artifact.summary, data: artifact.data }),
    8_000 + index,
    `artifact:${artifact.id}`
  ))
  const canonSources = eligibleCanon.map((fact) => createSource(
    'canon',
    fact.id,
    fact.subject,
    `${fact.subject}: ${fact.fact}`,
    500 + lexicalScore(queryTokens, `${fact.subject} ${fact.fact}`) + fact.confidence * 20,
    `canon:${fact.id}`
  ))
  const summarySources = eligibleSummaries.map((summary) => createSource(
    'chapter_summary',
    summary.id,
    `Chương ${summary.chapterNumber} · ${summary.chapterTitle}`,
    JSON.stringify({
      summary: summary.summary,
      keyEvents: summary.keyEvents,
      characters: summary.characters,
      locations: summary.locations,
      unresolvedThreads: summary.unresolvedThreads
    }),
    300 + lexicalScore(queryTokens, `${summary.chapterTitle} ${summary.summary} ${summary.keyEvents.join(' ')}`)
      + Math.max(0, 40 - (input.chapter.number - summary.chapterNumber)),
    `chapter-summary:${summary.chapterId}:v${summary.sourceVersion}`
  ))
  const ranked = [...artifactSources, ...canonSources, ...summarySources].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const selected: ContextSource[] = []
  let used = 0
  let omittedSources = 0
  let truncatedSources = 0
  let artifactTokens = 0
  const artifactTokenLimit = Math.max(256, Math.floor(limit * 0.5))

  for (const source of fixedSources) {
    const remaining = Math.max(0, limit - used)
    const fitted = fitSource(source, Math.min(remaining, Math.max(256, Math.floor(limit * 0.3))))
    if (!fitted) {
      omittedSources += 1
      continue
    }
    selected.push(fitted.source)
    used += fitted.source.tokenEstimate
    truncatedSources += fitted.truncated ? 1 : 0
  }
  for (const source of ranked) {
    const remaining = Math.max(0, limit - used)
    if (remaining < 32) {
      omittedSources += 1
      continue
    }
    const mayTruncate = source.kind === 'workflow_artifact'
    const artifactRemaining = Math.max(0, artifactTokenLimit - artifactTokens)
    const allowance = mayTruncate ? Math.min(remaining, artifactRemaining) : remaining
    const fitted = source.tokenEstimate <= allowance ? { source, truncated: false } : mayTruncate ? fitSource(source, allowance) : null
    if (!fitted) {
      omittedSources += 1
      continue
    }
    selected.push(fitted.source)
    used += fitted.source.tokenEstimate
    if (source.kind === 'workflow_artifact') artifactTokens += fitted.source.tokenEstimate
    truncatedSources += fitted.truncated ? 1 : 0
  }

  return LongContextPacketSchema.parse({
    query,
    sources: selected,
    continuityIssues,
    budget: { limit, used: Math.min(used, limit), omittedSources, truncatedSources }
  })
}

export function rebudgetLongContextPacket(packet: LongContextPacket, tokenBudget: number): LongContextPacket {
  const limit = Math.max(2_000, Math.trunc(tokenBudget))
  const selected: ContextSource[] = []
  let used = 0
  let omittedSources = packet.budget.omittedSources
  let truncatedSources = packet.budget.truncatedSources
  let artifactTokens = 0
  const artifactTokenLimit = Math.max(256, Math.floor(limit * 0.5))
  for (const source of packet.sources) {
    const remaining = Math.max(0, limit - used)
    const artifactRemaining = Math.max(0, artifactTokenLimit - artifactTokens)
    const allowance = source.kind === 'workflow_artifact'
      ? Math.min(remaining, artifactRemaining)
      : source.kind === 'brief' || source.kind === 'outline'
        ? Math.min(remaining, Math.max(256, Math.floor(limit * 0.3)))
        : remaining
    if (source.tokenEstimate <= allowance) {
      selected.push(source)
      used += source.tokenEstimate
      if (source.kind === 'workflow_artifact') artifactTokens += source.tokenEstimate
      continue
    }
    const fitted = source.kind === 'brief' || source.kind === 'outline' || source.kind === 'workflow_artifact'
      ? fitSource(source, allowance)
      : null
    if (!fitted) {
      omittedSources += 1
      continue
    }
    selected.push(fitted.source)
    used += fitted.source.tokenEstimate
    if (source.kind === 'workflow_artifact') artifactTokens += fitted.source.tokenEstimate
    truncatedSources += fitted.truncated ? 1 : 0
  }
  return LongContextPacketSchema.parse({
    ...packet,
    sources: selected,
    budget: { limit, used: Math.min(used, limit), omittedSources, truncatedSources }
  })
}

function detectContinuityIssues(
  input: LongContextInput,
  summaries: ChapterSummary[],
  futureCanon: BootstrapSnapshot['canon']
): ContinuityIssue[] {
  const issues: ContinuityIssue[] = []
  if (futureCanon.length > 0) {
    issues.push({
      code: 'future_canon',
      severity: 'warning',
      message: `${futureCanon.length} dữ kiện từ chương hiện tại hoặc tương lai đã bị loại để tránh rò rỉ diễn biến.`,
      sources: futureCanon.map((fact) => `canon:${fact.id}`)
    })
  }
  const history = normalizeForSearch(summaries.map((summary) => summary.summary).join(' '))
  for (const forbidden of input.brief.mustAvoid) {
    if (includesPhrase(history, forbidden)) {
      issues.push({
        code: 'must_avoid',
        severity: 'critical',
        message: `Lịch sử chương có dấu hiệu chạm ràng buộc cần tránh: “${forbidden}”.`,
        sources: summaries.filter((summary) => includesPhrase(normalizeForSearch(summary.summary), forbidden)).map((summary) => `chapter-summary:${summary.chapterId}:v${summary.sourceVersion}`)
      })
    }
  }
  const recent = summaries.slice().sort((a, b) => b.chapterNumber - a.chapterNumber).slice(0, 3)
  const recentText = normalizeForSearch(`${recent.map((summary) => summary.summary).join(' ')} ${input.outline.purpose}`)
  for (const motif of input.brief.mustInclude) {
    if (!includesPhrase(recentText, motif)) {
      issues.push({
        code: 'missing_motif',
        severity: 'info',
        message: `Theo dõi motif đã khóa nhưng chưa xuất hiện trong ba tóm tắt gần nhất: “${motif}”.`,
        sources: ['author-brief:latest', `outline:chapter-${input.outline.number}`]
      })
    }
  }
  for (const summary of recent) {
    for (const thread of summary.unresolvedThreads.slice(0, 2)) {
      issues.push({
        code: 'open_thread',
        severity: 'info',
        message: `Tuyến chưa khép từ chương ${summary.chapterNumber}: ${thread}`,
        sources: [`chapter-summary:${summary.chapterId}:v${summary.sourceVersion}`]
      })
    }
  }
  return issues.slice(0, 12)
}

function createSource(
  kind: ContextSource['kind'],
  id: string,
  label: string,
  excerpt: string,
  score: number,
  provenance: string
): ContextSource {
  return { kind, id, label, excerpt, score, tokenEstimate: estimateTokens(excerpt), provenance }
}

function fitSource(source: ContextSource, remaining: number): { source: ContextSource; truncated: boolean } | null {
  if (source.tokenEstimate <= remaining) return { source, truncated: false }
  if (remaining < 32) return null
  const excerpt = truncateText(source.excerpt, Math.max(64, remaining * 4 - 24))
  return {
    source: { ...source, excerpt: `${excerpt}…`, tokenEstimate: Math.min(remaining, estimateTokens(`${excerpt}…`)) },
    truncated: true
  }
}

function lexicalScore(queryTokens: Set<string>, value: string): number {
  const candidate = tokenSet(value)
  let overlap = 0
  for (const token of candidate) if (queryTokens.has(token)) overlap += 1
  return overlap * 12
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeForSearch(value).match(/[a-z0-9]{2,}/g) ?? [])
}

function includesPhrase(normalizedText: string, phrase: string): boolean {
  const normalizedPhrase = normalizeForSearch(phrase)
  return normalizedPhrase.length > 1 && normalizedText.includes(normalizedPhrase)
}

function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('vi').replace(/đ/g, 'd').replace(/\s+/g, ' ').trim()
}

function splitSentences(value: string): string[] {
  return value.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/u).map((sentence) => sentence.trim()).filter(Boolean)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function truncateText(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const sliced = value.slice(0, maximum)
  const boundary = sliced.lastIndexOf(' ')
  return sliced.slice(0, boundary > maximum * 0.65 ? boundary : maximum).trim()
}

function extractDocumentText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const record = node as Record<string, unknown>
  const own = typeof record.text === 'string' ? record.text : ''
  const children = Array.isArray(record.content) ? record.content.map(extractDocumentText).filter(Boolean).join(' ') : ''
  return `${own} ${children}`.trim()
}
