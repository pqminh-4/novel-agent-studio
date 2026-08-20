import { contextBridge, ipcRenderer } from 'electron'

const api = {
  invoke: <T>(channel: string, payload: unknown = {}): Promise<T> => ipcRenderer.invoke('runtime:invoke', { channel, payload }),
  vault: {
    list: <T>(): Promise<T> => ipcRenderer.invoke('vault:list'),
    save: <T>(input: unknown): Promise<T> => ipcRenderer.invoke('vault:save', input),
    remove: (kind: string): Promise<void> => ipcRenderer.invoke('vault:remove', kind),
    test: <T>(kind: string): Promise<T> => ipcRenderer.invoke('vault:test', kind),
    preferred: <T>(): Promise<T> => ipcRenderer.invoke('vault:preferred'),
    setPreferred: (kind: string): Promise<void> => ipcRenderer.invoke('vault:set-preferred', kind),
    routing: <T>(): Promise<T> => ipcRenderer.invoke('vault:routing'),
    setRoute: <T>(route: unknown): Promise<T> => ipcRenderer.invoke('vault:set-route', route)
  },
  backup: (): Promise<unknown> => ipcRenderer.invoke('backup:create'),
  restoreBackup: (): Promise<unknown> => ipcRenderer.invoke('backup:restore'),
  projectArchive: {
    export: (): Promise<unknown> => ipcRenderer.invoke('archive:export'),
    import: (): Promise<unknown> => ipcRenderer.invoke('archive:import')
  },
  recovery: {
    status: (): Promise<unknown> => ipcRenderer.invoke('recovery:status'),
    restart: (): Promise<void> => ipcRenderer.invoke('recovery:restart')
  },
  exportBook: (format: 'markdown' | 'docx' | 'epub' | 'pdf'): Promise<{ path: string } | null> => ipcRenderer.invoke('export:book', format)
}

contextBridge.exposeInMainWorld('novelAgent', api)
