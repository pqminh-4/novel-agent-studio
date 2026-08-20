import { describe, expect, it } from 'vitest'
import { buildLongContextPacket, rebudgetLongContextPacket, summarizeChapter } from '@infra/index'
import type { Chapter, ChapterSummary, StoryBrief, WorkflowArtifact } from '@core/index'

const brief: StoryBrief = {
  premise: 'Một thủ thư phục hồi ký ức đã mất của thành phố.',
  genres: ['Kỳ ảo'],
  audience: 'Trưởng thành',
  setting: 'Thành phố Lam Kính',
  protagonists: ['An'],
  conflict: 'Mỗi ký ức được cứu đòi một đánh đổi.',
  pointOfView: 'Ngôi ba giới hạn theo An',
  tense: 'Quá khứ',
  tone: 'U hoài',
  targetChapters: 24,
  endingDirection: 'Hy vọng có đánh đổi',
  mustInclude: ['đèn thủy tinh'],
  mustAvoid: ['công nghệ hiện đại'],
  contentLimits: ''
}

function chapter(number: number, content: Record<string, unknown>, summary = ''): Chapter {
  return {
    id: `chapter-${number}`,
    bookId: 'book-1',
    number,
    title: `Chương ${number}`,
    summary,
    status: 'approved',
    content,
    wordCount: 20,
    updatedAt: '2026-08-19T00:00:00.000Z'
  }
}

describe('context truyện dài P0.4', () => {
  it('tạo tóm tắt chương có version, thực thể và tuyến chưa khép', () => {
    const result = summarizeChapter({
      chapter: chapter(3, {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'An bước vào Tháp Chuông và nhìn thấy chiếc đèn thủy tinh.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Cô vẫn không biết ai đã xóa cái tên khỏi ký ức?' }] }
        ]
      }, 'An tìm thấy một dấu vết mới.'),
      sourceVersion: 7,
      canon: [
        { id: 'canon-an', bookId: 'book-1', category: 'character', subject: 'An', fact: 'Thủ thư ký ức', sourceChapter: null, confidence: 1 },
        { id: 'canon-tower', bookId: 'book-1', category: 'location', subject: 'Tháp Chuông', fact: 'Nằm ở trung tâm Lam Kính', sourceChapter: 2, confidence: 0.9 }
      ],
      now: '2026-08-19T00:00:00.000Z'
    })

    expect(result).toMatchObject({ chapterNumber: 3, sourceVersion: 7, characters: ['An'], locations: ['Tháp Chuông'] })
    expect(result.keyEvents.length).toBeGreaterThan(0)
    expect(result.unresolvedThreads[0]).toContain('không biết')
    expect(result.tokenEstimate).toBeGreaterThan(0)
  })

  it('xếp hạng nguồn liên quan, loại canon tương lai và không vượt token budget', () => {
    const summaries: ChapterSummary[] = [
      {
        id: 'summary-8', chapterId: 'chapter-8', bookId: 'book-1', chapterNumber: 8, chapterTitle: 'Chiếc đèn trở lại',
        sourceVersion: 2, summary: 'An tìm thấy đèn thủy tinh dưới Tháp Chuông.', keyEvents: ['Chiếc đèn phát sáng.'],
        characters: ['An'], locations: ['Tháp Chuông'], unresolvedThreads: ['Ai đã thắp chiếc đèn?'], tokenEstimate: 40, updatedAt: '2026-08-19T00:00:00.000Z'
      },
      {
        id: 'summary-7', chapterId: 'chapter-7', bookId: 'book-1', chapterNumber: 7, chapterTitle: 'Cỗ máy',
        sourceVersion: 1, summary: 'Một công nghệ hiện đại được dùng để giải thích phép thuật.', keyEvents: [],
        characters: [], locations: [], unresolvedThreads: [], tokenEstimate: 30, updatedAt: '2026-08-18T00:00:00.000Z'
      }
    ]
    const hugeArtifact: WorkflowArtifact = {
      id: 'artifact-draft', runId: 'run-1', stepId: 'step-1', chapterId: 'chapter-9', kind: 'draft', roleId: 'writer',
      status: 'proposal', title: 'Bản nháp dài', summary: 'Bản nháp đang xử lý', data: { document: 'x'.repeat(20_000) },
      createdAt: '2026-08-19T00:00:00.000Z', reviewedAt: null
    }
    const packet = buildLongContextPacket({
      brief,
      outline: { number: 9, title: 'Ánh sáng cuối', purpose: 'An dùng đèn thủy tinh để tìm lời giải.', status: 'ready' },
      chapter: chapter(9, { type: 'doc', content: [{ type: 'paragraph' }] }),
      canon: [
        { id: 'canon-lamp', bookId: 'book-1', category: 'object', subject: 'Đèn thủy tinh', fact: 'Lưu trữ ký ức', sourceChapter: 2, confidence: 0.95 },
        { id: 'canon-future', bookId: 'book-1', category: 'event', subject: 'Kết cục', fact: 'Bí mật ở chương 12', sourceChapter: 12, confidence: 1 }
      ],
      chapterSummaries: summaries,
      previousArtifacts: [hugeArtifact],
      tokenBudget: 2_000
    })

    expect(packet.budget.used).toBeLessThanOrEqual(2_000)
    expect(packet.sources.some((source) => source.id === 'canon-lamp')).toBe(true)
    expect(packet.sources.some((source) => source.id === 'canon-future')).toBe(false)
    expect(packet.sources.some((source) => source.id === 'summary-8')).toBe(true)
    expect(packet.continuityIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'future_canon', severity: 'warning' }),
      expect.objectContaining({ code: 'must_avoid', severity: 'critical' }),
      expect.objectContaining({ code: 'open_thread' })
    ]))
  })

  it('rebudget packet giữ provenance nhưng tiếp tục tuân thủ giới hạn mới', () => {
    const packet = buildLongContextPacket({
      brief,
      outline: { number: 4, title: 'Đường về', purpose: 'An trở lại Lam Kính.', status: 'ready' },
      chapter: chapter(4, { type: 'doc', content: [{ type: 'paragraph' }] }),
      canon: [],
      chapterSummaries: [],
      previousArtifacts: [],
      tokenBudget: 8_000
    })
    const smaller = rebudgetLongContextPacket(packet, 2_000)

    expect(smaller.budget.limit).toBe(2_000)
    expect(smaller.budget.used).toBeLessThanOrEqual(2_000)
    expect(smaller.sources.map((source) => source.provenance)).toEqual(packet.sources.map((source) => source.provenance))
  })
})
