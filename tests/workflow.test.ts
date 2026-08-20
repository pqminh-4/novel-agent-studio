import { describe, expect, it } from 'vitest'
import { assertJobTransition, canTransitionJob, getWorkflowSteps } from '@core/index'

describe('workflow công việc AI', () => {
  it('chỉ cho phép các chuyển trạng thái đã định nghĩa', () => {
    expect(canTransitionJob('queued', 'preparing')).toBe(true)
    expect(canTransitionJob('streaming', 'completed')).toBe(false)
    expect(() => assertJobTransition('completed', 'queued')).toThrow(/Không thể chuyển/)
  })

  it('sắp đúng vòng sửa và chỉ tạo canon sau bản thảo cuối', () => {
    expect(getWorkflowSteps('fast').map((step) => step.kind)).toEqual([
      'brief_handoff', 'outline_handoff', 'scene_plan', 'context_packet', 'draft', 'canon_delta'
    ])

    const qualityKinds = getWorkflowSteps('quality').map((step) => step.kind)
    expect(qualityKinds.slice(-5)).toEqual([
      'editorial_report', 'revision_plan', 'revised_draft', 'canon_delta', 'visual_note'
    ])
  })
})
