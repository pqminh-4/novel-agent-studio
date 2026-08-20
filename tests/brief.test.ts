import { describe, expect, it } from 'vitest'
import { calculateBriefReadiness, getMissingBriefFields, StoryBriefSchema } from '@core/index'

describe('độ sẵn sàng của định hướng tác giả', () => {
  it('không cho phép brief trống đạt trạng thái sẵn sàng', () => {
    const brief = StoryBriefSchema.parse({})
    expect(calculateBriefReadiness(brief)).toBeLessThan(20)
    expect(getMissingBriefFields(brief)).toContain('premise')
  })

  it('đạt 100 khi mọi trường bắt buộc đã có dữ liệu', () => {
    const brief = StoryBriefSchema.parse({
      premise: 'Một người giữ ký ức phải cứu thành phố đang quên chính mình.',
      genres: ['Kỳ ảo', 'Bí ẩn'],
      audience: 'Độc giả trưởng thành',
      setting: 'Thành phố nổi cuối thế kỷ XIX giả tưởng',
      protagonists: ['An'],
      conflict: 'Mỗi ký ức được cứu sẽ xóa một phần con người của An.',
      pointOfView: 'Ngôi ba giới hạn',
      tone: 'U hoài nhưng giàu hy vọng',
      endingDirection: 'Khép kín, đánh đổi có ý nghĩa'
    })
    expect(calculateBriefReadiness(brief)).toBe(100)
    expect(getMissingBriefFields(brief)).toEqual([])
  })
})
