import { z } from 'zod'
import { WorkflowArtifactKindSchema, type ProviderKind, type WorkflowArtifactKind, type WorkflowRunStatus } from '@core/index'
import { NovelDatabase, type WorkflowArtifactDraft, type WorkflowStepLease } from './database'
import { generateTextDetailed, ProviderRequestError, type ProviderRequestEvent, type ProviderSecret } from './providers'

const DocumentSchema = z.object({
  type: z.literal('doc'),
  content: z.array(z.record(z.string(), z.unknown())).min(1)
})

const PayloadSchemas: Record<WorkflowArtifactKind, z.ZodType<Record<string, unknown>>> = {
  brief_handoff: z.object({ premise: z.string(), tone: z.string(), pointOfView: z.string(), constraints: z.array(z.string()) }),
  outline_handoff: z.object({ chapterNumber: z.number().int().positive(), title: z.string(), purpose: z.string() }),
  scene_plan: z.object({ scenes: z.array(z.object({ title: z.string(), goal: z.string(), conflict: z.string(), outcome: z.string() })).min(1) }),
  context_packet: z.object({
    query: z.string(),
    sources: z.array(z.object({
      kind: z.enum(['brief', 'outline', 'canon', 'chapter_summary', 'workflow_artifact']),
      id: z.string(),
      label: z.string(),
      excerpt: z.string(),
      score: z.number(),
      tokenEstimate: z.number().int().min(0),
      provenance: z.string()
    })),
    canonIds: z.array(z.string()),
    canonSubjects: z.array(z.string()),
    chapterSummaryIds: z.array(z.string()),
    sourceChapterId: z.string(),
    provenance: z.array(z.string()),
    continuityIssues: z.array(z.object({
      code: z.string(),
      severity: z.enum(['info', 'warning', 'critical']),
      message: z.string(),
      sources: z.array(z.string())
    })),
    budget: z.object({
      limit: z.number().int().positive(),
      used: z.number().int().min(0),
      omittedSources: z.number().int().min(0),
      truncatedSources: z.number().int().min(0)
    })
  }),
  draft: z.object({ document: DocumentSchema, wordCount: z.number().int().min(1) }),
  editorial_report: z.object({ strengths: z.array(z.string()), issues: z.array(z.object({ severity: z.enum(['low', 'medium', 'high']), message: z.string() })) }),
  revision_plan: z.object({ actions: z.array(z.object({ priority: z.number().int().positive(), instruction: z.string() })).min(1) }),
  revised_draft: z.object({ document: DocumentSchema, wordCount: z.number().int().min(1), appliedActions: z.array(z.string()) }),
  canon_delta: z.object({
    chapterSummary: z.string().min(1),
    keyEvents: z.array(z.string()),
    unresolvedThreads: z.array(z.string()),
    facts: z.array(z.object({
      category: z.enum(['character', 'location', 'rule', 'event', 'object']),
      subject: z.string(),
      fact: z.string(),
      sourceChapter: z.number().int().positive(),
      confidence: z.number().min(0).max(1)
    }))
  }),
  visual_note: z.object({ palette: z.array(z.string()), motifs: z.array(z.string()), continuityWarnings: z.array(z.string()) })
}

export type WorkflowGenerationContext = {
  signal?: AbortSignal
  onProviderEvent: (event: ProviderRequestEvent) => void
}

export type WorkflowArtifactGenerator = (lease: WorkflowStepLease, context?: WorkflowGenerationContext) => Promise<WorkflowArtifactDraft> | WorkflowArtifactDraft

export type WorkflowProviderRouteSecret = {
  roleId: string
  provider: ProviderKind
  model: string
  apiKey?: string
  endpoint?: string
  inputCostPerMillion?: number | null
  outputCostPerMillion?: number | null
  contextTokenBudget: number
}

export class DurableWorkflowEngine {
  constructor(
    private readonly database: NovelDatabase,
    private readonly delayMs = 120,
    private readonly generator: WorkflowArtifactGenerator = generateDeterministicArtifact
  ) {}

  async advance(runId: string, signal?: AbortSignal): Promise<WorkflowRunStatus | null> {
    let lease: WorkflowStepLease | null = null
    try {
      lease = this.database.claimWorkflowStep(runId)
      if (!lease) return this.database.getWorkflowRunStatus(runId)
      if (this.delayMs > 0) await delay(this.delayMs)
      if (signal?.aborted) return this.database.getWorkflowRunStatus(runId)
      const draft = await this.generator(lease, {
        signal,
        onProviderEvent: (event) => this.database.recordWorkflowProviderEvent(lease!, event)
      })
      validateWorkflowArtifactDraft(lease.kind, draft)
      this.database.completeWorkflowStep(lease, draft)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Artifact không hợp lệ.'
      if (lease && error instanceof ProviderRequestError) this.database.failWorkflowStep(lease, message, {
        billingState: error.billingState,
        requestId: error.details.requestId,
        httpStatus: error.details.httpStatus,
        retryCount: error.details.retryCount,
        retryAt: error.details.retryAt,
        inputTokens: error.details.usage?.inputTokens,
        outputTokens: error.details.usage?.outputTokens,
        estimatedCost: error.details.estimatedCost,
        costStatus: error.details.costStatus,
        provider: error.details.provider,
        model: error.details.model
      })
      else if (lease) this.database.failWorkflowStep(lease, message)
      else this.database.failWorkflowRun(runId, message)
    }
    return this.database.getWorkflowRunStatus(runId)
  }

  async runUntilBlocked(runId: string, maxSteps = 40): Promise<WorkflowRunStatus | null> {
    let status = this.database.getWorkflowRunStatus(runId)
    let count = 0
    while ((status === 'queued' || status === 'running') && count < maxSteps) {
      status = await this.advance(runId)
      count += 1
    }
    return status
  }
}

export function createRoutedArtifactGenerator(routes: WorkflowProviderRouteSecret[]): WorkflowArtifactGenerator {
  const byRole = new Map(routes.map((route) => [route.roleId, route]))
  return async (lease, context) => {
    const route = byRole.get(lease.roleId)
    if (lease.provider === 'demo' || lease.kind === 'context_packet') return generateDeterministicArtifact(lease)
    if (!route || route.provider !== lease.provider || route.model !== lease.model) {
      throw new Error(`Thiếu đúng cấu hình ${lease.provider}/${lease.model} đã khóa cho vai trò ${lease.roleId}.`)
    }
    if (!route.apiKey && route.provider !== 'ollama') throw new Error(`Vai trò ${lease.roleId} chưa có API key khả dụng.`)
    if (!route.endpoint) throw new Error(`Vai trò ${lease.roleId} chưa có endpoint khả dụng.`)
    const secret: ProviderSecret = {
      kind: route.provider,
      apiKey: route.apiKey ?? '',
      endpoint: route.endpoint,
      model: route.model,
      inputCostPerMillion: route.inputCostPerMillion,
      outputCostPerMillion: route.outputCostPerMillion
    }
    const result = await generateTextDetailed(secret, buildWorkflowPrompt(lease), {
      signal: context?.signal,
      timeoutMs: 120_000,
      maxRetries: 2,
      maxOutputTokens: lease.kind === 'draft' || lease.kind === 'revised_draft' ? 6_000 : 2_000,
      onEvent: context?.onProviderEvent
    })
    try {
      const envelope = parseJsonEnvelope(result.text)
      const draft: WorkflowArtifactDraft = {
        title: String(envelope.title ?? ''),
        summary: String(envelope.summary ?? ''),
        data: envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {},
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        estimatedCost: result.estimatedCost,
        provider: result.provider,
        model: result.model,
        requestId: result.requestId,
        httpStatus: result.httpStatus,
        retryCount: result.retryCount,
        costStatus: result.costStatus
      }
      return validateWorkflowArtifactDraft(lease.kind, draft)
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error
      throw new ProviderRequestError('Provider đã trả lời nhưng artifact không đúng JSON contract; request có thể đã được tính phí.', 'invalid_response', 'confirmed', {
        requestId: result.requestId,
        httpStatus: result.httpStatus,
        retryCount: result.retryCount,
        retryAt: null,
        usage: result.usage,
        estimatedCost: result.estimatedCost,
        costStatus: result.costStatus,
        provider: result.provider,
        model: result.model
      })
    }
  }
}

export function validateWorkflowArtifactDraft(kind: WorkflowArtifactKind, draft: WorkflowArtifactDraft): WorkflowArtifactDraft {
  WorkflowArtifactKindSchema.parse(kind)
  z.object({
    title: z.string().trim().min(1).max(240),
    summary: z.string().trim().min(1).max(4000),
    data: PayloadSchemas[kind],
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    estimatedCost: z.number().min(0),
    provider: z.enum(['demo', 'openai', 'anthropic', 'gemini', 'ollama']),
    model: z.string().min(1),
    requestId: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    retryCount: z.number().int().min(0),
    costStatus: z.enum(['not_applicable', 'estimated', 'unknown'])
  }).parse(draft)
  return draft
}

export function generateDeterministicArtifact(lease: WorkflowStepLease): WorkflowArtifactDraft {
  const chapterLabel = `Chương ${lease.chapter.number} · ${lease.chapter.title}`
  const base = createArtifactBase(lease)
  switch (lease.kind) {
    case 'brief_handoff':
      return withUsage(base, 'Định hướng đã khóa', `Brief cho ${chapterLabel} đã được đóng gói với ràng buộc nguồn.`, {
        premise: lease.brief.premise,
        tone: lease.brief.tone,
        pointOfView: lease.brief.pointOfView,
        constraints: [...lease.brief.mustInclude, ...lease.brief.mustAvoid.map((item) => `Tránh: ${item}`)]
      })
    case 'outline_handoff':
      return withUsage(base, 'Mục tiêu dàn ý', lease.outline.purpose, {
        chapterNumber: lease.outline.number,
        title: lease.outline.title,
        purpose: lease.outline.purpose
      })
    case 'scene_plan':
      return withUsage(base, 'Scene cards', 'Ba cảnh có mục tiêu, xung đột và điểm chuyển rõ ràng.', {
        scenes: [
          { title: 'Mở nhịp', goal: `Đặt ${lease.chapter.title} vào chuyển động.`, conflict: lease.brief.conflict || 'Một trở lực chưa được gọi tên.', outcome: 'Nhân vật buộc phải hành động.' },
          { title: 'Siết xung đột', goal: lease.outline.purpose, conflict: 'Thông tin mới làm lựa chọn trở nên khó khăn hơn.', outcome: 'Cái giá của lựa chọn được hé lộ.' },
          { title: 'Điểm ngoặt', goal: 'Khép mục tiêu chương bằng một thay đổi không thể bỏ qua.', conflict: 'Nhân vật phải đánh đổi.', outcome: 'Mở đường cho chương kế tiếp.' }
        ]
      })
    case 'context_packet':
      return withUsage(base, 'Gói ngữ cảnh có nguồn', `${lease.contextPacket.sources.length} nguồn dùng ${lease.contextPacket.budget.used}/${lease.contextPacket.budget.limit} token.`, {
        query: lease.contextPacket.query,
        sources: lease.contextPacket.sources,
        canonIds: lease.contextPacket.sources.filter((source) => source.kind === 'canon').map((source) => source.id),
        canonSubjects: lease.contextPacket.sources.filter((source) => source.kind === 'canon').map((source) => source.label),
        chapterSummaryIds: lease.contextPacket.sources.filter((source) => source.kind === 'chapter_summary').map((source) => source.id),
        sourceChapterId: lease.chapter.id,
        provenance: lease.contextPacket.sources.map((source) => source.provenance),
        continuityIssues: lease.contextPacket.continuityIssues,
        budget: lease.contextPacket.budget
      })
    case 'draft': {
      const paragraphs = draftParagraphs(lease, false)
      return withUsage(base, 'Bản nháp của Nhà văn', 'Bản nháp được giữ riêng và chưa ghi vào chương.', {
        document: toDocument(paragraphs),
        wordCount: countWords(paragraphs.join(' '))
      })
    }
    case 'editorial_report':
      return withUsage(base, 'Báo cáo biên tập', 'Báo cáo chỉ chẩn đoán, không có quyền sửa prose.', {
        strengths: ['Mục tiêu chương hiện diện rõ', 'Hình ảnh trung tâm bám sát brief'],
        issues: [
          { severity: 'medium', message: 'Tăng lực cản ở giữa chương để điểm ngoặt có trọng lượng hơn.' },
          { severity: 'low', message: 'Giữ nhất quán điểm nhìn trong các đoạn chuyển cảnh.' }
        ]
      })
    case 'revision_plan':
      return withUsage(base, 'Kế hoạch chỉnh sửa', 'Các hành động sửa được sắp theo ưu tiên và chưa đụng vào bản thảo.', {
        actions: [
          { priority: 1, instruction: 'Làm rõ lựa chọn trung tâm và cái giá ngay trước điểm ngoặt.' },
          { priority: 2, instruction: 'Thêm một chi tiết cảm giác gắn với biểu tượng chính.' },
          { priority: 3, instruction: 'Kiểm tra lại POV và thì kể theo brief.' }
        ]
      })
    case 'revised_draft': {
      const paragraphs = draftParagraphs(lease, true)
      return withUsage(base, 'Bản sửa đề xuất', 'Nhà văn đã áp dụng kế hoạch sửa vào một artifact mới.', {
        document: toDocument(paragraphs),
        wordCount: countWords(paragraphs.join(' ')),
        appliedActions: ['Làm rõ lựa chọn trung tâm', 'Tăng chi tiết cảm giác', 'Giữ nhất quán POV']
      })
    }
    case 'canon_delta':
      return withUsage(base, 'Canon delta đề xuất', 'Dữ kiện chỉ được commit nếu bản thảo cuối được duyệt.', {
        chapterSummary: `${lease.outline.purpose} Kết quả của chương mở ra hệ quả cần được theo dõi ở chương tiếp theo.`,
        keyEvents: [lease.outline.purpose],
        unresolvedThreads: lease.contextPacket.continuityIssues.filter((issue) => issue.code === 'open_thread').map((issue) => issue.message).slice(0, 4),
        facts: [{
          category: 'event',
          subject: lease.chapter.title,
          fact: `Sự kiện chính của chương ${lease.chapter.number}: ${lease.outline.purpose}`,
          sourceChapter: lease.chapter.number,
          confidence: 0.86
        }]
      })
    case 'visual_note':
      return withUsage(base, 'Ghi chú continuity hình ảnh', 'Giám đốc hình ảnh chỉ ghi nhận motif, không gọi image API.', {
        palette: ['ink', 'amber', 'night-blue'],
        motifs: lease.brief.mustInclude.slice(0, 3),
        continuityWarnings: ['Giữ tỷ lệ kiến trúc và nguồn sáng nhất quán với visual bible.']
      })
  }
}

type ArtifactExecutionBase = Pick<WorkflowArtifactDraft,
  'inputTokens' | 'outputTokens' | 'estimatedCost' | 'provider' | 'model' | 'requestId' | 'httpStatus' | 'retryCount' | 'costStatus'>

function createArtifactBase(lease: WorkflowStepLease): ArtifactExecutionBase {
  const input = JSON.stringify({ chapter: lease.chapter.id, contextPacket: lease.contextPacket })
  return {
    inputTokens: Math.max(1, Math.ceil(input.length / 4)),
    outputTokens: 0,
    estimatedCost: 0,
    provider: 'demo',
    model: 'deterministic-v1',
    requestId: null,
    httpStatus: null,
    retryCount: 0,
    costStatus: 'not_applicable'
  }
}

function withUsage(
  base: ArtifactExecutionBase,
  title: string,
  summary: string,
  data: Record<string, unknown>
): WorkflowArtifactDraft {
  return { ...base, title, summary, data, outputTokens: Math.max(1, Math.ceil(JSON.stringify(data).length / 4)) }
}

function draftParagraphs(lease: WorkflowStepLease, revised: boolean): string[] {
  const protagonist = lease.brief.protagonists[0]?.split('—')[0]?.trim() || 'Nhân vật chính'
  const setting = lease.brief.setting || 'không gian của câu chuyện'
  const turn = revised ? 'Lần này, lựa chọn không còn là một ý nghĩ có thể rút lại.' : 'Một thay đổi nhỏ trong im lặng báo trước rằng mọi thứ đã bắt đầu.'
  return [
    `${protagonist} bước vào ${setting} với cảm giác rằng nơi quen thuộc vừa lệch khỏi quỹ đạo cũ.`,
    `${lease.outline.purpose} ${turn}`,
    `Khi dấu hiệu cuối cùng hiện ra, ${protagonist} hiểu rằng cái giá của bước tiếp theo sẽ đi cùng mình sang chương kế tiếp.`
  ]
}

function toDocument(paragraphs: string[]): Record<string, unknown> {
  return {
    type: 'doc',
    content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
  }
}

function countWords(value: string): number {
  return value.trim() ? value.trim().split(/\s+/).length : 0
}

function buildWorkflowPrompt(lease: WorkflowStepLease): string {
  const roleGuard = lease.roleId === 'writer'
    ? 'Bạn là vai trò Nhà văn và chỉ tạo prose bên trong data.document khi contract yêu cầu.'
    : 'Bạn không phải Nhà văn: không trực tiếp viết hoặc sửa prose; chỉ tạo artifact phân tích có cấu trúc theo contract.'
  return [
    'Bạn đang thực thi một checkpoint trong workflow sáng tác tiểu thuyết có approval gate.',
    'Trả về đúng một JSON object, không markdown, không code fence, không giải thích ngoài JSON.',
    'JSON gốc phải có đúng ba khóa: title, summary, data.',
    'title và summary viết bằng tiếng Việt, ngắn gọn nhưng có thông tin.',
    roleGuard,
    `Vai trò: ${lease.roleId}. Checkpoint: ${lease.kind}.`,
    `Contract bắt buộc của data: ${artifactContract(lease.kind)}.`,
    `Ngữ cảnh đã khóa trong ngân sách ${lease.contextPacket.budget.used}/${lease.contextPacket.budget.limit} token: ${JSON.stringify({
      chapter: { id: lease.chapter.id, number: lease.chapter.number, title: lease.chapter.title, summary: lease.chapter.summary },
      contextPacket: lease.contextPacket
    })}`
  ].join('\n')
}

function artifactContract(kind: WorkflowArtifactKind): string {
  const contracts: Record<WorkflowArtifactKind, string> = {
    brief_handoff: '{ premise: string, tone: string, pointOfView: string, constraints: string[] }',
    outline_handoff: '{ chapterNumber: integer > 0, title: string, purpose: string }',
    scene_plan: '{ scenes: [{ title: string, goal: string, conflict: string, outcome: string }, ...] }',
    context_packet: '{ query: string, sources: ContextSource[], canonIds: string[], canonSubjects: string[], chapterSummaryIds: string[], sourceChapterId: string, provenance: string[], continuityIssues: [{ code, severity, message, sources }], budget: { limit, used, omittedSources, truncatedSources } }',
    draft: '{ document: { type: "doc", content: TiptapNode[] }, wordCount: integer > 0 }',
    editorial_report: '{ strengths: string[], issues: [{ severity: "low" | "medium" | "high", message: string }] }',
    revision_plan: '{ actions: [{ priority: integer > 0, instruction: string }, ...] }',
    revised_draft: '{ document: { type: "doc", content: TiptapNode[] }, wordCount: integer > 0, appliedActions: string[] }',
    canon_delta: '{ chapterSummary: string, keyEvents: string[], unresolvedThreads: string[], facts: [{ category: "character" | "location" | "rule" | "event" | "object", subject: string, fact: string, sourceChapter: integer > 0, confidence: number 0..1 }] }',
    visual_note: '{ palette: string[], motifs: string[], continuityWarnings: string[] }'
  }
  return contracts[kind]
}

function parseJsonEnvelope(value: string): Record<string, unknown> {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('Không tìm thấy JSON object trong phản hồi.')
  const parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON artifact phải là object.')
  return parsed as Record<string, unknown>
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
