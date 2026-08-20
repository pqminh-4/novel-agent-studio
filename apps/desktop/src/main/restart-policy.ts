/**
 * Chính sách khởi động lại Application Runtime.
 *
 * Tách riêng khỏi RuntimeBridge để kiểm thử được mà không cần Electron. Mục đích
 * là chặn crash-loop: nếu runtime chết liên tục (ví dụ một dòng dữ liệu làm crash
 * lúc mở SQLite), fork lại vô hạn sẽ tạo vòng lặp im lặng và mất tiến độ workflow
 * ở mỗi lượt.
 */

/** Số lần runtime được phép tự khởi động lại trong một cửa sổ thời gian. */
export const MAX_RESTARTS = 3
export const RESTART_WINDOW_MS = 60_000
/** Backoff giữa các lần khởi động lại, theo số lần đã thất bại liên tiếp. */
export const RESTART_BACKOFF_MS = [0, 500, 2_000, 5_000]

export class RestartPolicy {
  private timestamps: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** Xoá lịch sử sau một lần khởi động thành công. */
  reset(): void {
    this.timestamps = []
  }

  /** Số lần crash còn nằm trong cửa sổ thời gian. */
  get recentCrashes(): number {
    return this.prune().length
  }

  /**
   * Ghi nhận một lần runtime chết ngoài dự kiến.
   * @returns số lần crash trong cửa sổ, và có vượt ngưỡng hay không.
   */
  recordCrash(): { restarts: number; exhausted: boolean } {
    const timestamps = this.prune()
    timestamps.push(this.now())
    this.timestamps = timestamps
    return { restarts: timestamps.length, exhausted: timestamps.length > MAX_RESTARTS }
  }

  /** Thời gian chờ trước lần fork tiếp theo. */
  nextBackoffMs(): number {
    const recent = this.prune().length
    return RESTART_BACKOFF_MS[Math.min(recent, RESTART_BACKOFF_MS.length - 1)]
  }

  private prune(): number[] {
    const cutoff = this.now() - RESTART_WINDOW_MS
    this.timestamps = this.timestamps.filter((at) => at > cutoff)
    return this.timestamps
  }
}

export function describeCrashLoop(restarts: number, code: number): string {
  return `Application Runtime đã dừng ${restarts} lần trong ${Math.round(RESTART_WINDOW_MS / 1_000)} giây (mã ${code}). `
    + 'Ứng dụng ngừng tự khởi động lại để tránh vòng lặp lỗi. Dữ liệu của bạn chưa bị thay đổi; hãy kiểm tra hoặc khôi phục trong Data Safety.'
}
