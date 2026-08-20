import { describe, expect, it } from 'vitest'
import { createOutlineProposal, runOfflineDirectorTurn } from '@infra/index'
import { StoryBriefSchema } from '@core/index'

describe('Đạo diễn và dàn ý tự động', () => {
  it('tạo đề xuất dàn ý ngay khi brief đạt 100%', () => {
    const brief = StoryBriefSchema.parse({
      premise: 'Một thủ thư phải cứu thành phố đang quên chính mình.',
      genres: ['Kỳ ảo'],
      audience: 'Độc giả trưởng thành',
      setting: 'Thành phố Lam Kính',
      protagonists: ['An — thủ thư ký ức'],
      conflict: 'Mỗi ký ức được cứu sẽ xóa một phần ký ức của An.',
      pointOfView: 'Ngôi ba giới hạn',
      tone: 'U hoài nhưng giàu hy vọng',
      targetChapters: 24
    })

    const turn = runOfflineDirectorTurn(brief, 'Chiến thắng có đánh đổi và khép lại bằng hy vọng.')
    const outline = createOutlineProposal(turn.brief)

    expect(turn.readiness).toBe(100)
    expect(turn.outlineReady).toBe(true)
    expect(outline).toHaveLength(24)
    expect(outline[0]).toMatchObject({ number: 1, status: 'ready' })
    expect(outline.at(-1)?.purpose).toContain('Chiến thắng có đánh đổi')
  })
})
