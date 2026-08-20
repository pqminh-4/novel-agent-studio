import {
  BRIEF_FIELD_LABELS,
  getMissingBriefFields,
  calculateBriefReadiness,
  type OutlineChapter,
  type StoryBrief
} from '@core/index'

const QUESTIONS: Partial<Record<keyof StoryBrief, string>> = {
  premise: 'Nếu tóm tắt trong một câu, biến cố nào buộc nhân vật chính phải bước vào câu chuyện?',
  genres: 'Bạn muốn tác phẩm thuộc những thể loại chính nào?',
  audience: 'Bạn đang viết cho nhóm độc giả nào và mức độ trưởng thành ra sao?',
  setting: 'Không gian và thời đại chính của câu chuyện là gì?',
  protagonists: 'Ai là nhân vật trung tâm, họ muốn gì và sợ mất điều gì nhất?',
  conflict: 'Xung đột cốt lõi nào khiến nhân vật không thể quay về cuộc sống cũ?',
  pointOfView: 'Bạn muốn kể ở ngôi thứ nhất, ngôi ba giới hạn hay đa điểm nhìn?',
  tone: 'Dư vị chủ đạo nên ấm áp, u tối, hài hước hay bi tráng?',
  endingDirection: 'Bạn muốn câu chuyện khép lại theo hướng chữa lành, bi kịch hay chiến thắng có đánh đổi?'
}

export type DirectorTurn = {
  brief: StoryBrief
  reply: string
  readiness: number
  outlineReady: boolean
  updatedField: keyof StoryBrief | null
}

export function runOfflineDirectorTurn(current: StoryBrief, userMessage: string): DirectorTurn {
  const brief = structuredClone(current)
  const missing = getMissingBriefFields(brief)
  const target = missing[0] ?? null

  if (target) applyNaturalAnswer(brief, target, userMessage)

  const readiness = calculateBriefReadiness(brief)
  const remaining = getMissingBriefFields(brief)
  if (readiness === 100) {
    return {
      brief,
      readiness,
      outlineReady: true,
      updatedField: target,
      reply: 'Tôi đã có đủ các quyết định nền tảng. Tôi sẽ đóng gói chúng thành một phiên bản Định hướng tác giả và chuyển cho Kiến trúc sư dựng dàn ý. Bạn vẫn có thể chỉnh từng trường trước khi duyệt.'
    }
  }

  const next = remaining[0]
  const acknowledged = target
    ? `Tôi đã ghi nhận ${BRIEF_FIELD_LABELS[target].toLowerCase()}: “${summarize(userMessage)}”. `
    : ''
  return {
    brief,
    readiness,
    outlineReady: false,
    updatedField: target,
    reply: `${acknowledged}${QUESTIONS[next] ?? `Bạn muốn xác định thêm điều gì cho ${BRIEF_FIELD_LABELS[next].toLowerCase()}?`}`
  }
}

export function createOutlineProposal(brief: StoryBrief): OutlineChapter[] {
  const protagonist = brief.protagonists[0]?.split(/[—–,-]/)[0]?.trim() || 'Nhân vật chính'
  const chapterCount = brief.targetChapters
  return Array.from({ length: chapterCount }, (_item, index) => {
    const chapterNumber = index + 1
    const progress = chapterNumber / chapterCount
    const phase = outlinePhase(progress)
    const title = phase.titles[Math.min(phase.titles.length - 1, Math.floor(((chapterNumber - 1) % Math.max(1, Math.ceil(chapterCount / 4))) / Math.max(1, Math.ceil(chapterCount / 4)) * phase.titles.length))]
    return {
      number: chapterNumber,
      title: `${title}${chapterCount > 24 ? ` · ${chapterNumber}` : ''}`,
      purpose: phase.purpose(protagonist, brief),
      status: chapterNumber === 1 ? 'ready' : 'planned'
    }
  })
}

function outlinePhase(progress: number): {
  titles: string[]
  purpose: (protagonist: string, brief: StoryBrief) => string
} {
  if (progress <= 0.25) {
    return {
      titles: ['Dấu hiệu đầu tiên', 'Vết nứt', 'Lời gọi', 'Cánh cửa', 'Lựa chọn', 'Qua ngưỡng'],
      purpose: (protagonist, brief) => `Thiết lập đời sống của ${protagonist} trong ${brief.setting} và tăng sức ép để nhân vật không thể né tránh biến cố trung tâm.`
    }
  }
  if (progress <= 0.5) {
    return {
      titles: ['Luật chơi', 'Đồng minh', 'Thử lửa', 'Manh mối', 'Điểm giữa', 'Sự thật đổi chiều'],
      purpose: (protagonist, brief) => `${protagonist} chủ động khám phá thế giới truyện, trả giá cho từng lựa chọn và chạm vào một sự thật làm đổi nghĩa xung đột: ${brief.conflict}`
    }
  }
  if (progress <= 0.75) {
    return {
      titles: ['Áp lực', 'Rạn vỡ', 'Mất mát', 'Cái giá', 'Đêm tối', 'Quyết tâm'],
      purpose: (protagonist, _brief) => `Thu hẹp lựa chọn của ${protagonist}, làm đứt một điểm tựa quan trọng và buộc nhân vật xác định điều sẵn sàng đánh đổi trước hồi cuối.`
    }
  }
  return {
    titles: ['Kế hoạch cuối', 'Đối đầu', 'Đánh đổi', 'Đỉnh điểm', 'Hậu quả', 'Điều còn lại'],
    purpose: (protagonist, brief) => `${protagonist} đưa lựa chọn cốt lõi đến hành động, giải quyết xung đột chính và dẫn câu chuyện về dư vị kết thúc: ${brief.endingDirection}`
  }
}

function applyNaturalAnswer(brief: StoryBrief, field: keyof StoryBrief, answer: string): void {
  switch (field) {
    case 'genres':
    case 'protagonists':
    case 'mustInclude':
    case 'mustAvoid':
      brief[field] = answer.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
      break
    case 'targetChapters': {
      const value = Number(answer.match(/\d+/)?.[0] ?? 24)
      brief.targetChapters = Math.min(5000, Math.max(1, value))
      break
    }
    default:
      brief[field] = answer as never
  }
}

function summarize(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized
}
