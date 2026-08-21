import { z } from 'zod'

export const ProjectStatusSchema = z.enum(['planning', 'writing', 'reviewing', 'completed'])
export const ChapterStatusSchema = z.enum(['planned', 'drafting', 'review', 'approved'])
export const BriefFieldStatusSchema = z.enum(['unknown', 'proposed', 'confirmed', 'deferred', 'conflicted'])
export const ProviderKindSchema = z.enum(['demo', 'openai', 'anthropic', 'gemini', 'ollama'])
export const OutlineVersionStatusSchema = z.enum(['proposal', 'approved', 'restored'])
export const WorkflowPresetSchema = z.enum(['fast', 'balanced', 'quality'])
export const WorkflowRunStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'waiting_review',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'billing_unknown'
])
export const WorkflowStepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'billing_unknown'])
export const BillingStateSchema = z.enum(['not_started', 'not_billed', 'confirmed', 'unknown'])
export const CostStatusSchema = z.enum(['not_applicable', 'estimated', 'unknown'])
export const WorkflowArtifactKindSchema = z.enum([
  'brief_handoff',
  'outline_handoff',
  'scene_plan',
  'context_packet',
  'draft',
  'editorial_report',
  'revision_plan',
  'revised_draft',
  'canon_delta',
  'visual_note'
])
export const WorkflowArtifactStatusSchema = z.enum(['proposal', 'approved', 'rejected', 'committed'])

const EntityIdSchema = z.string().trim().min(1).max(160)
const RequiredNameSchema = z.string().trim().min(1).max(180)
const OptionalDescriptionSchema = z.string().trim().max(4000).default('')

export const StoryBriefSchema = z.object({
  premise: z.string().default(''),
  genres: z.array(z.string()).default([]),
  audience: z.string().default(''),
  setting: z.string().default(''),
  protagonists: z.array(z.string()).default([]),
  conflict: z.string().default(''),
  pointOfView: z.string().default(''),
  tense: z.string().default(''),
  tone: z.string().default(''),
  targetChapters: z.number().int().min(1).max(5000).default(24),
  endingDirection: z.string().default(''),
  mustInclude: z.array(z.string()).default([]),
  mustAvoid: z.array(z.string()).default([]),
  contentLimits: z.string().default('')
})

export type StoryBrief = z.infer<typeof StoryBriefSchema>

export const BriefFieldSchema = z.object({
  key: StoryBriefSchema.keyof(),
  label: z.string(),
  status: BriefFieldStatusSchema,
  valuePreview: z.string(),
  sourceMessageId: z.string().nullable().default(null)
})

export const RoleProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  shortName: z.string(),
  description: z.string(),
  color: z.string(),
  provider: ProviderKindSchema,
  model: z.string(),
  state: z.enum(['ready', 'working', 'waiting', 'blocked'])
})

export const SeriesSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  bookCount: z.number().int(),
  updatedAt: z.string()
})

export const BookSchema = z.object({
  id: z.string(),
  seriesId: z.string(),
  title: z.string(),
  genre: z.string(),
  status: ProjectStatusSchema,
  targetChapters: z.number().int(),
  approvedChapters: z.number().int(),
  updatedAt: z.string()
})

export const SeriesInputSchema = z.object({
  name: RequiredNameSchema,
  description: OptionalDescriptionSchema
})

export const CreateSeriesInputSchema = SeriesInputSchema
export const UpdateSeriesInputSchema = SeriesInputSchema.extend({ id: EntityIdSchema })
export const ArchiveSeriesInputSchema = z.object({ id: EntityIdSchema })

export const BookInputSchema = z.object({
  seriesId: EntityIdSchema,
  title: RequiredNameSchema,
  genre: z.string().trim().max(180).default(''),
  status: ProjectStatusSchema.default('planning'),
  targetChapters: z.number().int().min(1).max(5000).default(24)
})

export const CreateBookInputSchema = BookInputSchema
export const UpdateBookInputSchema = BookInputSchema.extend({ id: EntityIdSchema })
export const ArchiveBookInputSchema = z.object({ id: EntityIdSchema })
export const SwitchBookInputSchema = z.object({ bookId: EntityIdSchema })

export const ChapterSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  number: z.number().int(),
  title: z.string(),
  summary: z.string(),
  status: ChapterStatusSchema,
  content: z.record(z.string(), z.unknown()),
  // Bật khi content_json trong SQLite không parse được. Giữ chương ở trạng thái
  // chỉ đọc để autosave không ghi đè mất bản gốc đã hỏng.
  contentCorrupt: z.boolean().default(false),
  wordCount: z.number().int(),
  updatedAt: z.string()
})

export const CreateChapterInputSchema = z.object({
  bookId: EntityIdSchema,
  title: RequiredNameSchema,
  summary: z.string().trim().max(8000).default(''),
  status: ChapterStatusSchema.default('planned')
})

export const UpdateChapterInputSchema = z.object({
  id: EntityIdSchema,
  title: RequiredNameSchema,
  summary: z.string().trim().max(8000).default(''),
  status: ChapterStatusSchema
})

export const ArchiveChapterInputSchema = z.object({ id: EntityIdSchema })
export const SaveChapterInputSchema = z.object({
  chapterId: EntityIdSchema,
  content: z.record(z.string(), z.unknown()),
  wordCount: z.number().int().min(0).max(10_000_000)
})

export const ChatMessageSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  role: z.enum(['user', 'director', 'system']),
  content: z.string(),
  createdAt: z.string()
})

export const OutlineChapterSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  purpose: z.string(),
  status: z.enum(['planned', 'ready', 'drafting', 'complete'])
})

export const OutlineVersionSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  version: z.number().int().positive(),
  status: OutlineVersionStatusSchema,
  originVersion: z.number().int().positive().nullable(),
  createdAt: z.string(),
  approvedAt: z.string().nullable(),
  chapters: z.array(OutlineChapterSchema)
})

export const OutlineBookInputSchema = z.object({ bookId: EntityIdSchema })
export const OutlineVersionInputSchema = z.object({ versionId: EntityIdSchema })
export const DirectorMessageInputSchema = z.object({
  bookId: EntityIdSchema,
  content: z.string().trim().min(1).max(50_000)
})

export const CanonFactSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  category: z.enum(['character', 'location', 'rule', 'event', 'object']),
  subject: z.string(),
  fact: z.string(),
  sourceChapter: z.number().int().nullable(),
  confidence: z.number().min(0).max(1)
})

export const ChapterSummarySchema = z.object({
  id: z.string(),
  chapterId: z.string(),
  bookId: z.string(),
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  sourceVersion: z.number().int().min(0),
  summary: z.string(),
  keyEvents: z.array(z.string()),
  characters: z.array(z.string()),
  locations: z.array(z.string()),
  unresolvedThreads: z.array(z.string()),
  tokenEstimate: z.number().int().min(0),
  updatedAt: z.string()
})

export const ContinuityIssueSchema = z.object({
  code: z.enum(['future_canon', 'must_avoid', 'open_thread', 'missing_motif']),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  sources: z.array(z.string())
})

export const ContextSourceSchema = z.object({
  kind: z.enum(['brief', 'outline', 'canon', 'chapter_summary', 'workflow_artifact']),
  id: z.string(),
  label: z.string(),
  excerpt: z.string(),
  score: z.number(),
  tokenEstimate: z.number().int().min(0),
  provenance: z.string()
})

export const LongContextPacketSchema = z.object({
  query: z.string(),
  sources: z.array(ContextSourceSchema),
  continuityIssues: z.array(ContinuityIssueSchema),
  budget: z.object({
    limit: z.number().int().min(1),
    used: z.number().int().min(0),
    omittedSources: z.number().int().min(0),
    truncatedSources: z.number().int().min(0)
  })
})

export const ProviderConnectionSchema = z.object({
  kind: ProviderKindSchema.exclude(['demo']),
  name: z.string(),
  endpoint: z.string(),
  model: z.string(),
  maskedKey: z.string(),
  configured: z.boolean()
})

export const ProviderRouteSchema = z.object({
  roleId: EntityIdSchema,
  provider: ProviderKindSchema,
  model: z.string().trim().min(1).max(240),
  inputCostPerMillion: z.number().min(0).nullable().default(null),
  outputCostPerMillion: z.number().min(0).nullable().default(null),
  contextTokenBudget: z.number().int().min(2_000).max(1_000_000).default(16_000)
})

export const BackupKindSchema = z.enum(['sqlite', 'project_archive', 'migration', 'pre_restore'])

export const BackupInspectionSchema = z.object({
  kind: BackupKindSchema,
  path: z.string(),
  appVersion: z.string().nullable(),
  createdAt: z.string().nullable(),
  schemaVersion: z.number().int().min(1),
  integrity: z.literal('ok'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  seriesCount: z.number().int().nonnegative(),
  bookCount: z.number().int().nonnegative(),
  chapterCount: z.number().int().nonnegative()
})

export const RecoveryPointSchema = z.object({
  path: z.string(),
  kind: BackupKindSchema,
  createdAt: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  schemaVersion: z.number().int().min(0).nullable(),
  integrity: z.enum(['ok', 'unreadable'])
})

export const RecoveryReasonSchema = z.enum([
  'database_corrupt',
  'database_newer',
  'runtime_startup',
  'restore_failed'
])

export const RecoveryStatusSchema = z.object({
  safeMode: z.boolean(),
  reason: RecoveryReasonSchema.nullable(),
  detail: z.string(),
  databasePath: z.string(),
  schemaVersion: z.number().int().min(0).nullable(),
  recoveryPoints: z.array(RecoveryPointSchema)
})

/**
 * Trạng thái auto-update chia sẻ giữa main process và renderer.
 * Đặt trong core để renderer không phải import từ thư mục main.
 */
export const UpdateStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('checking') }),
  z.object({ status: z.literal('available'), version: z.string(), notes: z.string().nullable() }),
  z.object({ status: z.literal('downloading'), version: z.string(), percent: z.number().min(0).max(100) }),
  z.object({ status: z.literal('downloaded'), version: z.string() }),
  z.object({ status: z.literal('installing'), version: z.string() }),
  z.object({ status: z.literal('current'), version: z.string() }),
  z.object({ status: z.literal('deferred'), message: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
  z.object({ status: z.literal('unsupported'), message: z.string() })
])

export const RecoveryActionResultSchema = z.object({
  path: z.string(),
  recoveryPointPath: z.string().nullable(),
  restartRequired: z.boolean(),
  inspection: BackupInspectionSchema
})

export const ProjectArchiveManifestSchema = z.object({
  format: z.literal('novel-agent-project'),
  formatVersion: z.literal(1),
  appVersion: z.string(),
  createdAt: z.string(),
  schemaVersion: z.number().int().min(1),
  databaseFile: z.literal('project.sqlite'),
  databaseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  includesSecrets: z.literal(false),
  stats: z.object({
    series: z.number().int().nonnegative(),
    books: z.number().int().nonnegative(),
    chapters: z.number().int().nonnegative()
  })
})

export const SetProviderRouteInputSchema = ProviderRouteSchema

export const RuntimeJobSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  label: z.string(),
  roleId: z.string(),
  status: z.enum([
    'queued',
    'preparing',
    'submitting',
    'streaming',
    'validating',
    'waiting_review',
    'committing',
    'completed',
    'paused',
    'cancel_requested',
    'cancelled',
    'failed',
    'interrupted',
    'billing_unknown'
  ]),
  progress: z.number().min(0).max(100),
  detail: z.string(),
  startedAt: z.string().nullable(),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  estimatedCost: z.number().min(0).default(0),
  costStatus: CostStatusSchema.default('not_applicable'),
  updatedAt: z.string().default('')
})

export const WorkflowStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  ordinal: z.number().int().min(0),
  roleId: z.string(),
  kind: WorkflowArtifactKindSchema,
  label: z.string(),
  provider: ProviderKindSchema,
  model: z.string(),
  contextTokenBudget: z.number().int().min(2_000),
  promptVersion: z.string(),
  status: WorkflowStepStatusSchema,
  attemptCount: z.number().int().min(0),
  requestId: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  retryCount: z.number().int().min(0),
  retryAt: z.string().nullable(),
  billingState: BillingStateSchema,
  costStatus: CostStatusSchema,
  lastError: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable()
})

export const WorkflowArtifactSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  chapterId: z.string(),
  kind: WorkflowArtifactKindSchema,
  roleId: z.string(),
  status: WorkflowArtifactStatusSchema,
  title: z.string(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  reviewedAt: z.string().nullable()
})

export const WorkflowRunSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  chapterId: z.string(),
  chapterNumber: z.number().int().positive(),
  chapterTitle: z.string(),
  preset: WorkflowPresetSchema,
  status: WorkflowRunStatusSchema,
  currentStep: z.number().int().min(0),
  progress: z.number().min(0).max(100),
  detail: z.string(),
  error: z.string().nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  estimatedCost: z.number().min(0),
  costStatus: CostStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  steps: z.array(WorkflowStepSchema),
  artifacts: z.array(WorkflowArtifactSchema)
})

export const StartWorkflowInputSchema = z.object({
  chapterId: EntityIdSchema,
  preset: WorkflowPresetSchema.default('balanced')
})
export const WorkflowRunInputSchema = z.object({ runId: EntityIdSchema })
export const ReviewWorkflowInputSchema = z.object({
  runId: EntityIdSchema,
  decision: z.enum(['approve', 'reject'])
})

export const BootstrapSnapshotSchema = z.object({
  series: z.array(SeriesSchema),
  books: z.array(BookSchema),
  activeBook: BookSchema,
  chapters: z.array(ChapterSchema),
  messages: z.array(ChatMessageSchema),
  brief: StoryBriefSchema,
  briefFields: z.array(BriefFieldSchema),
  readiness: z.number().min(0).max(100),
  outline: z.array(OutlineChapterSchema),
  outlineVersions: z.array(OutlineVersionSchema),
  canon: z.array(CanonFactSchema),
  chapterSummaries: z.array(ChapterSummarySchema),
  roles: z.array(RoleProfileSchema),
  jobs: z.array(RuntimeJobSchema),
  workflowRuns: z.array(WorkflowRunSchema),
  reviewArtifacts: z.array(WorkflowArtifactSchema),
  database: z.object({
    version: z.string(),
    fts5: z.boolean(),
    path: z.string(),
    schemaVersion: z.number().int().min(1)
  })
})

export type BootstrapSnapshot = z.infer<typeof BootstrapSnapshotSchema>
export type Series = z.infer<typeof SeriesSchema>
export type Book = z.infer<typeof BookSchema>
export type Chapter = z.infer<typeof ChapterSchema>
export type CreateSeriesInput = z.infer<typeof CreateSeriesInputSchema>
export type UpdateSeriesInput = z.infer<typeof UpdateSeriesInputSchema>
export type CreateBookInput = z.infer<typeof CreateBookInputSchema>
export type UpdateBookInput = z.infer<typeof UpdateBookInputSchema>
export type CreateChapterInput = z.infer<typeof CreateChapterInputSchema>
export type UpdateChapterInput = z.infer<typeof UpdateChapterInputSchema>
export type ChatMessage = z.infer<typeof ChatMessageSchema>
export type OutlineChapter = z.infer<typeof OutlineChapterSchema>
export type OutlineVersion = z.infer<typeof OutlineVersionSchema>
export type CanonFact = z.infer<typeof CanonFactSchema>
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>
export type ContinuityIssue = z.infer<typeof ContinuityIssueSchema>
export type ContextSource = z.infer<typeof ContextSourceSchema>
export type LongContextPacket = z.infer<typeof LongContextPacketSchema>
export type RoleProfile = z.infer<typeof RoleProfileSchema>
export type RuntimeJob = z.infer<typeof RuntimeJobSchema>
export type WorkflowPreset = z.infer<typeof WorkflowPresetSchema>
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>
export type WorkflowArtifact = z.infer<typeof WorkflowArtifactSchema>
export type WorkflowArtifactKind = z.infer<typeof WorkflowArtifactKindSchema>
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>
export type ProviderKind = z.infer<typeof ProviderKindSchema>
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>
export type ProviderRoute = z.infer<typeof ProviderRouteSchema>
export type BackupKind = z.infer<typeof BackupKindSchema>
export type BackupInspection = z.infer<typeof BackupInspectionSchema>
export type RecoveryPoint = z.infer<typeof RecoveryPointSchema>
export type RecoveryReason = z.infer<typeof RecoveryReasonSchema>
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>
export type RecoveryActionResult = z.infer<typeof RecoveryActionResultSchema>
export type UpdateState = z.infer<typeof UpdateStateSchema>
export type ProjectArchiveManifest = z.infer<typeof ProjectArchiveManifestSchema>
export type BillingState = z.infer<typeof BillingStateSchema>
export type CostStatus = z.infer<typeof CostStatusSchema>

export const RuntimeRequestSchema = z.object({
  id: z.string(),
  channel: z.string(),
  payload: z.unknown()
})

export const RuntimeResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
})

export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>
export type RuntimeResponse = z.infer<typeof RuntimeResponseSchema>
