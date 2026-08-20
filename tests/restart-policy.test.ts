import { describe, expect, it } from 'vitest'
import {
  MAX_RESTARTS,
  RESTART_BACKOFF_MS,
  RESTART_WINDOW_MS,
  RestartPolicy,
  describeCrashLoop
} from '../apps/desktop/src/main/restart-policy'

function policyWithClock(): { policy: RestartPolicy; advance: (ms: number) => void } {
  let now = 1_000_000
  const policy = new RestartPolicy(() => now)
  return { policy, advance: (ms: number) => { now += ms } }
}

describe('chính sách khởi động lại runtime', () => {
  it('cho phép khởi động lại tới ngưỡng rồi mới dừng', () => {
    const { policy } = policyWithClock()
    for (let attempt = 1; attempt <= MAX_RESTARTS; attempt += 1) {
      expect(policy.recordCrash()).toEqual({ restarts: attempt, exhausted: false })
    }
    // Lần vượt ngưỡng phải dừng hẳn để không tạo crash-loop im lặng.
    expect(policy.recordCrash()).toEqual({ restarts: MAX_RESTARTS + 1, exhausted: true })
  })

  it('tăng backoff theo số lần crash liên tiếp', () => {
    const { policy } = policyWithClock()
    expect(policy.nextBackoffMs()).toBe(RESTART_BACKOFF_MS[0])
    policy.recordCrash()
    expect(policy.nextBackoffMs()).toBe(RESTART_BACKOFF_MS[1])
    policy.recordCrash()
    expect(policy.nextBackoffMs()).toBe(RESTART_BACKOFF_MS[2])
    policy.recordCrash()
    expect(policy.nextBackoffMs()).toBe(RESTART_BACKOFF_MS[3])
  })

  it('quên các lần crash đã rơi ra ngoài cửa sổ thời gian', () => {
    const { policy, advance } = policyWithClock()
    policy.recordCrash()
    policy.recordCrash()
    expect(policy.recentCrashes).toBe(2)

    advance(RESTART_WINDOW_MS + 1)
    expect(policy.recentCrashes).toBe(0)
    // Sự cố lẻ tẻ cách nhau xa không được cộng dồn thành fatal.
    expect(policy.recordCrash()).toEqual({ restarts: 1, exhausted: false })
  })

  it('xoá lịch sử sau khi khởi động lại thành công', () => {
    const { policy } = policyWithClock()
    policy.recordCrash()
    policy.recordCrash()
    policy.reset()
    expect(policy.recentCrashes).toBe(0)
    expect(policy.nextBackoffMs()).toBe(RESTART_BACKOFF_MS[0])
  })

  it('mô tả crash-loop có nêu rõ dữ liệu chưa bị thay đổi', () => {
    const message = describeCrashLoop(4, 1)
    expect(message).toContain('4 lần')
    expect(message).toContain('chưa bị thay đổi')
  })
})
