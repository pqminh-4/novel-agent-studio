import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import {
  DEFAULT_ROLES,
  ProviderConnectionSchema,
  ProviderRouteSchema,
  type ProviderConnection,
  type ProviderKind,
  type ProviderRoute
} from '@core/index'

type StoredConnection = ProviderConnection & {
  encryptedKey: string
}

export type ProviderConnectionInput = {
  kind: Exclude<ProviderKind, 'demo'>
  name: string
  endpoint: string
  model: string
  apiKey: string
}

type VaultPreferences = {
  kind?: Exclude<ProviderKind, 'demo'> | null
  routes?: ProviderRoute[]
}

export class CredentialVault {
  constructor(private readonly path: string) {}

  async list(): Promise<ProviderConnection[]> {
    const records = await this.readRecords()
    return records.map(({ encryptedKey: _encryptedKey, ...connection }) => ProviderConnectionSchema.parse(connection))
  }

  async save(input: ProviderConnectionInput): Promise<ProviderConnection> {
    const records = await this.readRecords()
    const existing = records.find((record) => record.kind === input.kind)
    validateConnectionInput(input, Boolean(existing))
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Windows DPAPI chưa sẵn sàng để bảo vệ API key.')
    }
    const encryptedKey = input.apiKey.trim()
      ? Buffer.from(await safeStorage.encryptStringAsync(input.apiKey)).toString('base64')
      : existing?.encryptedKey ?? ''
    const maskedKey = input.apiKey.trim() ? maskSecret(input.apiKey) : existing?.maskedKey ?? 'Cục bộ'
    const next: StoredConnection = {
      kind: input.kind,
      name: input.name.trim(),
      endpoint: normalizeEndpoint(input.endpoint),
      model: input.model.trim(),
      maskedKey,
      configured: true,
      encryptedKey
    }
    const filtered = records.filter((record) => record.kind !== input.kind)
    await this.writeRecords([...filtered, next])
    if (!(await this.getPreferredKind())) await this.setPreferredKind(input.kind)
    const { encryptedKey: _encryptedKey, ...connection } = next
    return ProviderConnectionSchema.parse(connection)
  }

  async remove(kind: Exclude<ProviderKind, 'demo'>): Promise<void> {
    const records = await this.readRecords()
    const remaining = records.filter((record) => record.kind !== kind)
    await this.writeRecords(remaining)
    const routes = (await this.listRoleRoutes()).map((route) => route.provider === kind
      ? {
          roleId: route.roleId,
          provider: 'demo' as const,
          model: 'deterministic-v1',
          inputCostPerMillion: null,
          outputCostPerMillion: null,
          contextTokenBudget: route.contextTokenBudget
        }
      : route)
    await this.writePreferences({ kind: remaining[0]?.kind ?? null, routes })
  }

  async getPreferredKind(): Promise<Exclude<ProviderKind, 'demo'> | null> {
    const directorRoute = (await this.listRoleRoutes()).find((route) => route.roleId === 'director')
    return directorRoute && directorRoute.provider !== 'demo' ? directorRoute.provider : null
  }

  async setPreferredKind(kind: Exclude<ProviderKind, 'demo'>): Promise<void> {
    const connection = (await this.readRecords()).find((record) => record.kind === kind)
    if (!connection) throw new Error('Provider cần được kết nối trước khi chọn cho Đạo diễn.')
    const current = (await this.listRoleRoutes()).find((route) => route.roleId === 'director')
    await this.setRoleRoute({
      roleId: 'director',
      provider: kind,
      model: connection.model,
      inputCostPerMillion: current?.provider === kind ? current.inputCostPerMillion : null,
      outputCostPerMillion: current?.provider === kind ? current.outputCostPerMillion : null,
      contextTokenBudget: current?.contextTokenBudget ?? 16_000
    })
  }

  async listRoleRoutes(): Promise<ProviderRoute[]> {
    const [records, preferences] = await Promise.all([this.readRecords(), this.readPreferences()])
    const explicit = new Map((preferences.routes ?? []).flatMap((route) => {
      const parsed = ProviderRouteSchema.safeParse(route)
      return parsed.success ? [[parsed.data.roleId, parsed.data] as const] : []
    }))
    return DEFAULT_ROLES.map((role) => {
      const saved = explicit.get(role.id)
      if (saved && (saved.provider === 'demo' || records.some((record) => record.kind === saved.provider))) return saved
      if (role.id === 'director' && preferences.kind) {
        const legacy = records.find((record) => record.kind === preferences.kind)
        if (legacy) return ProviderRouteSchema.parse({
          roleId: role.id,
          provider: legacy.kind,
          model: legacy.model,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
          contextTokenBudget: 16_000
        })
      }
      return ProviderRouteSchema.parse({
        roleId: role.id,
        provider: 'demo',
        model: 'deterministic-v1',
        inputCostPerMillion: null,
        outputCostPerMillion: null,
        contextTokenBudget: 16_000
      })
    })
  }

  async setRoleRoute(input: ProviderRoute): Promise<ProviderRoute> {
    const parsed = ProviderRouteSchema.parse(input)
    const route = parsed.provider === 'demo'
      ? { ...parsed, model: 'deterministic-v1', inputCostPerMillion: null, outputCostPerMillion: null }
      : parsed.provider === 'ollama'
        ? { ...parsed, inputCostPerMillion: null, outputCostPerMillion: null }
        : parsed
    if (!DEFAULT_ROLES.some((role) => role.id === route.roleId)) throw new Error('Vai trò AI không hợp lệ.')
    const records = await this.readRecords()
    if (route.provider !== 'demo' && !records.some((record) => record.kind === route.provider)) {
      throw new Error('Hãy kết nối provider trước khi gán cho vai trò.')
    }
    const routes = await this.listRoleRoutes()
    const next = routes.map((item) => item.roleId === route.roleId ? route : item)
    const director = next.find((item) => item.roleId === 'director')
    await this.writePreferences({ kind: director?.provider === 'demo' ? null : director?.provider, routes: next })
    return route
  }

  async reveal(kind: Exclude<ProviderKind, 'demo'>): Promise<ProviderConnectionInput | null> {
    const record = (await this.readRecords()).find((item) => item.kind === kind)
    if (!record) return null
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(record.encryptedKey, 'base64'))
    if (decrypted.shouldReEncrypt) {
      await this.save({
        kind: record.kind,
        name: record.name,
        endpoint: record.endpoint,
        model: record.model,
        apiKey: decrypted.result
      })
    }
    return {
      kind: record.kind,
      name: record.name,
      endpoint: record.endpoint,
      model: record.model,
      apiKey: decrypted.result
    }
  }

  private async readRecords(): Promise<StoredConnection[]> {
    try {
      const raw = await readFile(this.path, 'utf8')
      return JSON.parse(raw) as StoredConnection[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async writeRecords(records: StoredConnection[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.partial`
    await writeFile(temporary, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }

  private preferencePath(): string {
    return this.path.replace(/\.json$/i, '.preferences.json')
  }

  private async readPreferences(): Promise<VaultPreferences> {
    try {
      const raw = await readFile(this.preferencePath(), 'utf8')
      return JSON.parse(raw) as VaultPreferences
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private async writePreferences(preferences: VaultPreferences): Promise<void> {
    const path = this.preferencePath()
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.partial`
    await writeFile(temporary, JSON.stringify(preferences, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '••••••••'
  return `${value.slice(0, 3)}••••••${value.slice(-4)}`
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value)
  return url.toString().replace(/\/$/, '')
}

function validateConnectionInput(input: ProviderConnectionInput, canReuseExistingKey = false): void {
  if (!input.name.trim() || !input.model.trim()) throw new Error('Tên kết nối và model không được để trống.')
  if (!input.apiKey.trim() && input.kind !== 'ollama' && !canReuseExistingKey) throw new Error('API key không được để trống.')
  const url = new URL(input.endpoint)
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(input.kind === 'ollama' && url.protocol === 'http:' && loopback)) {
    throw new Error('Endpoint phải dùng HTTPS; HTTP chỉ được phép với Ollama loopback.')
  }
}
