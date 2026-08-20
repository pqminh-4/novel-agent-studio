import type { StoryBrief } from './contracts'

export const BRIEF_FIELD_LABELS: Record<keyof StoryBrief, string> = {
  premise: 'Tiền đề',
  genres: 'Thể loại',
  audience: 'Độc giả',
  setting: 'Bối cảnh',
  protagonists: 'Nhân vật chính',
  conflict: 'Xung đột',
  pointOfView: 'Góc nhìn',
  tense: 'Thì kể',
  tone: 'Sắc thái',
  targetChapters: 'Quy mô',
  endingDirection: 'Hướng kết thúc',
  mustInclude: 'Chi tiết bắt buộc',
  mustAvoid: 'Điều cần tránh',
  contentLimits: 'Giới hạn nội dung'
}

export const REQUIRED_BRIEF_FIELDS: Array<keyof StoryBrief> = [
  'premise',
  'genres',
  'audience',
  'setting',
  'protagonists',
  'conflict',
  'pointOfView',
  'tone',
  'targetChapters',
  'endingDirection'
]

function hasValue(value: StoryBrief[keyof StoryBrief]): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'number') return value > 0
  return value.trim().length > 0
}

export function calculateBriefReadiness(brief: StoryBrief): number {
  const completed = REQUIRED_BRIEF_FIELDS.filter((key) => hasValue(brief[key])).length
  return Math.round((completed / REQUIRED_BRIEF_FIELDS.length) * 100)
}

export function getMissingBriefFields(brief: StoryBrief): Array<keyof StoryBrief> {
  return REQUIRED_BRIEF_FIELDS.filter((key) => !hasValue(brief[key]))
}

export function toValuePreview(value: StoryBrief[keyof StoryBrief]): string {
  if (Array.isArray(value)) return value.join(', ') || 'Chưa xác định'
  if (typeof value === 'number') return `${value} chương`
  return value || 'Chưa xác định'
}
