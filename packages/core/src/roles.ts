import type { RoleProfile } from './contracts'

export const DEFAULT_ROLES: RoleProfile[] = [
  {
    id: 'director',
    name: 'Đạo diễn truyện',
    shortName: 'Đạo diễn',
    description: 'Phỏng vấn tác giả, hoàn thiện brief và điều phối toàn bộ workflow.',
    color: '#e4b66a',
    provider: 'demo',
    model: 'Chế độ demo',
    state: 'ready'
  },
  {
    id: 'architect',
    name: 'Kiến trúc sư',
    shortName: 'Kiến trúc',
    description: 'Thiết kế cấu trúc sách, tuyến truyện và dàn ý nhiều tầng.',
    color: '#a98ced',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  },
  {
    id: 'scene-planner',
    name: 'Hoạch định cảnh',
    shortName: 'Cảnh',
    description: 'Chuyển mục tiêu chương thành scene card rõ nhịp và xung đột.',
    color: '#72a9df',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  },
  {
    id: 'writer',
    name: 'Nhà văn',
    shortName: 'Nhà văn',
    description: 'Vai trò duy nhất được tạo và chỉnh sửa văn bản truyện.',
    color: '#ed8f7a',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  },
  {
    id: 'editor',
    name: 'Biên tập viên',
    shortName: 'Biên tập',
    description: 'Chẩn đoán cấu trúc, nhịp, giọng kể, logic và chất lượng câu chữ.',
    color: '#72c5a1',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  },
  {
    id: 'revision-adviser',
    name: 'Cố vấn chỉnh sửa',
    shortName: 'Cố vấn',
    description: 'Chuyển báo cáo biên tập thành kế hoạch sửa có thứ tự ưu tiên.',
    color: '#d8a9c5',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  },
  {
    id: 'librarian',
    name: 'Thủ thư Canon',
    shortName: 'Thủ thư',
    description: 'Truy xuất ký ức, kiểm tra continuity và đề xuất canon delta.',
    color: '#80bdc7',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  },
  {
    id: 'visual-director',
    name: 'Giám đốc hình ảnh',
    shortName: 'Hình ảnh',
    description: 'Giữ visual bible và chuẩn bị đề xuất bìa, minh họa có duyệt.',
    color: '#d7a36f',
    provider: 'demo',
    model: 'Kế thừa mặc định',
    state: 'waiting'
  }
]
