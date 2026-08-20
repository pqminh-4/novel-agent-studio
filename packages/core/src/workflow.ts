import type { WorkflowArtifactKind, WorkflowPreset } from './contracts'

export type WorkflowStepDefinition = {
  roleId: string
  kind: WorkflowArtifactKind
  label: string
}

const BALANCED_PIPELINE: WorkflowStepDefinition[] = [
  { roleId: 'director', kind: 'brief_handoff', label: 'Khóa định hướng chương' },
  { roleId: 'architect', kind: 'outline_handoff', label: 'Bàn giao mục tiêu dàn ý' },
  { roleId: 'scene-planner', kind: 'scene_plan', label: 'Hoạch định cảnh' },
  { roleId: 'librarian', kind: 'context_packet', label: 'Truy xuất canon và ngữ cảnh' },
  { roleId: 'writer', kind: 'draft', label: 'Viết bản nháp' },
  { roleId: 'editor', kind: 'editorial_report', label: 'Biên tập và chẩn đoán' },
  { roleId: 'revision-adviser', kind: 'revision_plan', label: 'Lập kế hoạch chỉnh sửa' },
  { roleId: 'writer', kind: 'revised_draft', label: 'Tạo bản sửa đề xuất' },
  { roleId: 'librarian', kind: 'canon_delta', label: 'Đề xuất canon delta' },
  { roleId: 'visual-director', kind: 'visual_note', label: 'Kiểm tra continuity hình ảnh' }
]

export const WORKFLOW_PIPELINE = BALANCED_PIPELINE.map((step) => step.roleId)

export function getWorkflowSteps(preset: WorkflowPreset): WorkflowStepDefinition[] {
  if (preset === 'fast') {
    return BALANCED_PIPELINE.filter((step) => !['editorial_report', 'revision_plan', 'revised_draft', 'visual_note'].includes(step.kind))
  }
  if (preset === 'quality') {
    const writingSteps = BALANCED_PIPELINE.filter((step) => !['canon_delta', 'visual_note'].includes(step.kind))
    const finalizationSteps = BALANCED_PIPELINE.filter((step) => ['canon_delta', 'visual_note'].includes(step.kind))
    return [
      ...writingSteps,
      { roleId: 'editor', kind: 'editorial_report', label: 'Biên tập vòng chất lượng' },
      { roleId: 'revision-adviser', kind: 'revision_plan', label: 'Kế hoạch sửa vòng chất lượng' },
      { roleId: 'writer', kind: 'revised_draft', label: 'Bản sửa chất lượng cuối' },
      ...finalizationSteps
    ]
  }
  return [...BALANCED_PIPELINE]
}

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'submitting'
  | 'streaming'
  | 'validating'
  | 'waiting_review'
  | 'committing'
  | 'completed'
  | 'paused'
  | 'cancel_requested'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'billing_unknown'

const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['preparing', 'cancelled', 'paused'],
  preparing: ['submitting', 'failed', 'cancelled', 'paused'],
  submitting: ['streaming', 'validating', 'failed', 'billing_unknown', 'cancel_requested', 'paused'],
  streaming: ['validating', 'failed', 'billing_unknown', 'cancel_requested', 'interrupted', 'paused'],
  validating: ['waiting_review', 'committing', 'failed', 'paused'],
  waiting_review: ['committing', 'cancelled', 'paused'],
  committing: ['completed', 'failed', 'interrupted'],
  completed: [],
  paused: ['queued', 'cancelled'],
  cancel_requested: ['cancelled', 'billing_unknown'],
  cancelled: [],
  failed: ['queued'],
  interrupted: ['queued', 'cancelled'],
  billing_unknown: ['queued', 'cancelled']
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) {
    throw new Error(`Không thể chuyển trạng thái công việc từ ${from} sang ${to}.`)
  }
}
