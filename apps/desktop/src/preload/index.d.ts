import type {
  BackupInspection,
  ProviderConnection,
  ProviderKind,
  ProviderRoute,
  RecoveryActionResult,
  RecoveryStatus
} from '@core/index'

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
  exportBook(format: 'markdown' | 'docx' | 'epub' | 'pdf'): Promise<{ path: string } | null>
}

declare global {
  interface Window {
    novelAgent: NovelAgentApi
  }
}
