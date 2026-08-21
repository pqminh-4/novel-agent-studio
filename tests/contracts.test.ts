import { describe, expect, it } from 'vitest'
import {
  CreateBookInputSchema,
  CreateChapterInputSchema,
  DirectorMessageInputSchema,
  OutlineVersionInputSchema,
  SaveChapterInputSchema,
  UpdateStateSchema
} from '@core/index'

describe('xác thực yêu cầu runtime P0.1', () => {
  it('từ chối payload thiếu định danh hoặc vượt giới hạn dữ liệu', () => {
    expect(CreateBookInputSchema.safeParse({ seriesId: '', title: '', targetChapters: 0 }).success).toBe(false)
    expect(CreateChapterInputSchema.safeParse({ bookId: 'book-1', title: '' }).success).toBe(false)
    expect(DirectorMessageInputSchema.safeParse({ bookId: 'book-1', content: ' '.repeat(3) }).success).toBe(false)
    expect(OutlineVersionInputSchema.safeParse({ versionId: '' }).success).toBe(false)
    expect(SaveChapterInputSchema.safeParse({ chapterId: 'chapter-1', content: {}, wordCount: -1 }).success).toBe(false)
  })

  it('chuẩn hóa khoảng trắng cho dữ liệu hợp lệ', () => {
    const parsed = CreateBookInputSchema.parse({
      seriesId: ' series-1 ',
      title: ' Sách mới ',
      genre: ' Kỳ ảo ',
      targetChapters: 24
    })
    expect(parsed).toMatchObject({ seriesId: 'series-1', title: 'Sách mới', genre: 'Kỳ ảo' })
  })

  it('chấp nhận trạng thái cập nhật đang cài và đã trì hoãn', () => {
    expect(UpdateStateSchema.parse({ status: 'installing', version: '0.1.8' })).toEqual({ status: 'installing', version: '0.1.8' })
    expect(UpdateStateSchema.parse({ status: 'deferred', message: 'Đã hoãn' })).toEqual({ status: 'deferred', message: 'Đã hoãn' })
  })
})
