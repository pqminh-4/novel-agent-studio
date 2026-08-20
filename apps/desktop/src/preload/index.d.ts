import type {
  BackupInspection,
  ProviderConnection,
  ProviderKind,
  ProviderRoute,
  RecoveryActionResult,
  RecoveryStatus,
  UpdateState
} from '@core/index'

export type ExportFormat = 'markdown' | 'docx' | 'epub' | 'pdf'
export type ExportBatchResult = {
  exported: Array<{ path: string; bookId: string; format: ExportFormat }>
  failed: Array<{ bookId: string; format: ExportFormat; message: string }>
}

export type NovelAgentApi = {
  invoke<T>(channel: string, payload?: unknown): Promise<T>
  vault: {
    list(): Promise<ProviderConnection[]>
    save(input: unknown): Promise<ProviderConnection>
    remove(kind: string): Promise<void>
    test(kind: string): Promise<{ ok: boolean; latencyMs: number; message: string }>
    preferred(): Promise<Exclude<ProviderKind, 'demo'> | null>
    setPreferred(kind: Exclude<ProviderKind, 'demo'>): Promise<void>
    routing(): Promise<ProviderRoute[]>
    setRoute(route: ProviderRoute): Promise<ProviderRoute>
  }
  backup(): Promise<{ pages: number; integrity: string; inspection: BackupInspection } | null>
  restoreBackup(): Promise<RecoveryActionResult | null>
  projectArchive: {
    export(): Promise<BackupInspection | null>
    import(): Promise<RecoveryActionResult | null>
  }
  recovery: {
    status(): Promise<RecoveryStatus>
    restart(): Promise<void>
    /** Đăng ký nhận tín hiệu runtime chết quá ngưỡng; trả về hàm huỷ đăng ký. */
    onFatal(listener: (reason: { message: string; restarts: number }) => void): () => void
  }
  exportBook(format: ExportFormat): Promise<{ path: string } | null>
  exportCustom(input: { bookId: string; chapterIds: string[]; formats: ExportFormat[] }): Promise<ExportBatchResult | null>
  exportBulk(input: { bookIds: string[]; formats: ExportFormat[] }): Promise<ExportBatchResult | null>
  updater: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
    /** Đăng ký nhận trạng thái cập nhật; trả về hàm huỷ đăng ký. */
    onState(listener: (state: UpdateState) => void): () => void
  }
  diagnostics: {
    openLogs(): Promise<{ error: string | null; path: string }>
  }
}

declare global {
  interface Window {
    novelAgent: NovelAgentApi
  }
}
