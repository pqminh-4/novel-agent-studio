import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { getMissingBriefFields, type BillingState, type CostStatus, type ProviderKind, type StoryBrief } from '@core/index'

export type ProviderSecret = {
  kind: Exclude<ProviderKind, 'demo'>
  apiKey: string
  endpoint: string
  model: string
  inputCostPerMillion?: number | null
  outputCostPerMillion?: number | null
}

export type ProviderHealth = {
  ok: boolean
  latencyMs: number
  message: string
}

export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
}

export type ProviderTextResult = {
  text: string
  provider: Exclude<ProviderKind, 'demo'>
  model: string
  requestId: string
  httpStatus: number
  retryCount: number
  usage: ProviderUsage
  estimatedCost: number
  costStatus: CostStatus
}

export type ProviderRequestEvent = {
  type: 'submitted' | 'retry_scheduled' | 'response'
  requestId: string
  retryCount: number
  httpStatus: number | null
  retryAt: string | null
  billingState: BillingState
}

export type ProviderRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  maxRetries?: number
  maxOutputTokens?: number
  transport?: typeof fetch
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  onEvent?: (event: ProviderRequestEvent) => void
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly code: 'authentication' | 'billing' | 'cancelled' | 'invalid_request' | 'invalid_response' | 'network' | 'rate_limit' | 'server_error' | 'timeout',
    readonly billingState: BillingState,
    readonly details: {
      requestId: string
      httpStatus: number | null
      retryCount: number
      retryAt: string | null
      usage?: ProviderUsage
      estimatedCost?: number
      costStatus?: CostStatus
      provider?: Exclude<ProviderKind, 'demo'>
      model?: string
    }
  ) {
    super(message)
    this.name = 'ProviderRequestError'
  }
}

type QueueEntry = {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class ProviderConcurrencyLimiter {
  private readonly active = new Map<string, number>()
  private readonly queues = new Map<string, QueueEntry[]>()

  constructor(private readonly maximumPerProvider = 2) {}

  async run<T>(provider: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(provider, signal)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(createCancelledError(false))
    const current = this.active.get(provider) ?? 0
    if (current < this.maximumPerProvider) {
      this.active.set(provider, current + 1)
      return Promise.resolve(this.createRelease(provider))
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, signal }
      entry.onAbort = () => {
        const queue = this.queues.get(provider) ?? []
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
        reject(createCancelledError(false))
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      const queue = this.queues.get(provider) ?? []
      queue.push(entry)
      this.queues.set(provider, queue)
    })
  }

  private createRelease(provider: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const queue = this.queues.get(provider) ?? []
      while (queue.length > 0) {
        const next = queue.shift()!
        next.signal?.removeEventListener('abort', next.onAbort!)
        if (next.signal?.aborted) continue
        next.resolve(this.createRelease(provider))
        return
      }
      this.active.set(provider, Math.max(0, (this.active.get(provider) ?? 1) - 1))
    }
  }
}

const TextEnvelopeSchema = z.object({ text: z.string().trim().min(1) })
const defaultLimiter = new ProviderConcurrencyLimiter(2)

export async function testProvider(secret: ProviderSecret): Promise<ProviderHealth> {
  const started = performance.now()
  try {
    await generateTextDetailed(secret, 'Trả lời đúng một từ: OK', { timeoutMs: 15_000, maxRetries: 0, maxOutputTokens: 16 })
    return { ok: true, latencyMs: Math.round(performance.now() - started), message: 'Kết nối thành công.' }
  } catch (error) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), message: safeErrorMessage(error, secret.apiKey) }
  }
}

export async function generateText(secret: ProviderSecret, prompt: string, signal?: AbortSignal): Promise<string> {
  return (await generateTextDetailed(secret, prompt, { signal })).text
}

export async function generateTextDetailed(secret: ProviderSecret, prompt: string, options: ProviderRequestOptions = {}): Promise<ProviderTextResult> {
  validateEndpoint(secret.kind, secret.endpoint)
  const transport = options.transport ?? fetch
  const sleep = options.sleep ?? abortableDelay
  const maximumRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2))
  let retryCount = 0

  while (true) {
    const clientRequestId = randomUUID()
    try {
      return await defaultLimiter.run(secret.kind, options.signal, () => executeAttempt(secret, prompt, clientRequestId, retryCount, transport, options))
    } catch (error) {
      const providerError = normalizeProviderError(error, clientRequestId, retryCount)
      if (providerError.code !== 'rate_limit' || retryCount >= maximumRetries || options.signal?.aborted) throw providerError
      const retryAt = providerError.details.retryAt ?? new Date(Date.now() + exponentialBackoff(retryCount)).toISOString()
      options.onEvent?.({
        type: 'retry_scheduled',
        requestId: providerError.details.requestId,
        retryCount: retryCount + 1,
        httpStatus: providerError.details.httpStatus,
        retryAt,
        billingState: 'not_billed'
      })
      retryCount += 1
      await sleep(Math.max(0, new Date(retryAt).getTime() - Date.now()), options.signal)
    }
  }
}

export async function generateDirectorReply(secret: ProviderSecret, input: {
  brief: StoryBrief
  userMessage: string
  fallbackReply: string
  readiness: number
}, signal?: AbortSignal): Promise<string> {
  const missing = getMissingBriefFields(input.brief)
  const prompt = [
    'Bạn là Đạo diễn truyện trong một ứng dụng sáng tác tiểu thuyết.',
    'Hãy trả lời bằng tiếng Việt, ấm áp, rõ ràng, tối đa 140 từ.',
    'Ghi nhận quyết định mới của tác giả nhưng không tự bịa dữ kiện.',
    missing.length > 0
      ? `Chỉ hỏi một câu quan trọng tiếp theo để làm rõ trường: ${missing[0]}.`
      : 'Thông báo đã đủ dữ kiện và sẽ chuyển brief cho Kiến trúc sư tự động dựng dàn ý.',
    `Độ hoàn chỉnh hiện tại: ${input.readiness}%.`,
    `Brief có cấu trúc: ${JSON.stringify(input.brief)}.`,
    `Tin nhắn mới của tác giả: ${input.userMessage}.`,
    `Câu trả lời dự phòng để giữ đúng nghiệp vụ: ${input.fallbackReply}`
  ].join('\n')
  return generateText(secret, prompt, signal)
}

async function executeAttempt(
  secret: ProviderSecret,
  prompt: string,
  clientRequestId: string,
  retryCount: number,
  transport: typeof fetch,
  options: ProviderRequestOptions
): Promise<ProviderTextResult> {
  const controller = new AbortController()
  let timedOut = false
  let submitted = false
  const abortFromCaller = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('timeout'))
  }, Math.max(1_000, options.timeoutMs ?? 90_000))

  try {
    const request = buildRequest(secret, prompt, options.maxOutputTokens ?? 120, controller.signal)
    options.onEvent?.({ type: 'submitted', requestId: clientRequestId, retryCount, httpStatus: null, retryAt: null, billingState: 'unknown' })
    submitted = true
    const response = await transport(request.url, request.init)
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? clientRequestId
    const data = await readResponseJson(response, requestId, retryCount, secret.apiKey)
    const parsed = parseProviderResponse(secret.kind, data, requestId, response.status, retryCount)
    const cost = calculateCost(secret, parsed.usage)
    options.onEvent?.({ type: 'response', requestId, retryCount, httpStatus: response.status, retryAt: null, billingState: 'confirmed' })
    return {
      ...parsed,
      provider: secret.kind,
      model: secret.model,
      requestId,
      httpStatus: response.status,
      retryCount,
      estimatedCost: cost.estimatedCost,
      costStatus: cost.costStatus
    }
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error
    if (timedOut) {
      throw new ProviderRequestError('Provider không phản hồi trong thời gian cho phép; chi phí của request chưa thể xác định.', 'timeout', submitted ? 'unknown' : 'not_billed', {
        requestId: clientRequestId, httpStatus: null, retryCount, retryAt: null
      })
    }
    if (options.signal?.aborted || isAbortError(error)) throw createCancelledError(submitted, clientRequestId, retryCount)
    throw new ProviderRequestError('Mất kết nối sau khi gửi request; chưa thể xác định provider có tính phí hay không.', 'network', submitted ? 'unknown' : 'not_billed', {
      requestId: clientRequestId, httpStatus: null, retryCount, retryAt: null
    })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

function buildRequest(secret: ProviderSecret, prompt: string, maxOutputTokens: number, signal: AbortSignal): { url: URL; init: RequestInit } {
  const common = { method: 'POST', signal }
  switch (secret.kind) {
    case 'openai':
      return {
        url: new URL('/v1/responses', secret.endpoint),
        init: { ...common, headers: { Authorization: `Bearer ${secret.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: secret.model, input: prompt, max_output_tokens: maxOutputTokens }) }
      }
    case 'anthropic':
      return {
        url: new URL('/v1/messages', secret.endpoint),
        init: { ...common, headers: { 'x-api-key': secret.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: secret.model, max_tokens: maxOutputTokens, messages: [{ role: 'user', content: prompt }] }) }
      }
    case 'gemini': {
      const url = new URL(`/v1beta/models/${encodeURIComponent(secret.model)}:generateContent`, secret.endpoint)
      url.searchParams.set('key', secret.apiKey)
      return {
        url,
        init: { ...common, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens } }) }
      }
    }
    case 'ollama':
      return {
        url: new URL('/api/chat', secret.endpoint),
        init: { ...common, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: secret.model, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: maxOutputTokens } }) }
      }
  }
}

async function readResponseJson(response: Response, requestId: string, retryCount: number, apiKey: string): Promise<Record<string, any>> {
  const data = await response.json().catch(() => ({})) as Record<string, any>
  if (response.ok) return data
  const retryAt = parseRetryAfter(response.headers.get('retry-after'))
  const rawMessage = data.error?.message ?? data.error ?? `Provider trả về HTTP ${response.status}.`
  const message = safeErrorMessage(new Error(String(rawMessage).slice(0, 500)), apiKey)
  const details = { requestId, httpStatus: response.status, retryCount, retryAt }
  if (response.status === 429) throw new ProviderRequestError(message, 'rate_limit', 'not_billed', details)
  if (response.status === 401 || response.status === 403) throw new ProviderRequestError(message, 'authentication', 'not_billed', details)
  if (response.status === 402) throw new ProviderRequestError(message, 'billing', 'not_billed', details)
  if (response.status >= 500 || response.status === 408) throw new ProviderRequestError(`${message} Chi phí của request chưa thể xác định.`, 'server_error', 'unknown', details)
  throw new ProviderRequestError(message, 'invalid_request', 'not_billed', details)
}

function parseProviderResponse(
  kind: ProviderSecret['kind'],
  data: Record<string, any>,
  requestId: string,
  httpStatus: number,
  retryCount: number
): { text: string; usage: ProviderUsage } {
  try {
    if (kind === 'openai') {
      const output = Array.isArray(data.output) ? data.output : []
      const fallbackText = output.flatMap((item) => Array.isArray(item.content) ? item.content : []).find((item) => item.type === 'output_text')?.text
      return { text: TextEnvelopeSchema.parse({ text: typeof data.output_text === 'string' ? data.output_text : fallbackText }).text, usage: normalizeUsage(data.usage?.input_tokens, data.usage?.output_tokens) }
    }
    if (kind === 'anthropic') {
      const text = Array.isArray(data.content) ? data.content.find((item) => item.type === 'text')?.text : undefined
      return { text: TextEnvelopeSchema.parse({ text }).text, usage: normalizeUsage(data.usage?.input_tokens, data.usage?.output_tokens) }
    }
    if (kind === 'gemini') {
      const text = data.candidates?.[0]?.content?.parts?.find((item: Record<string, unknown>) => typeof item.text === 'string')?.text
      return { text: TextEnvelopeSchema.parse({ text }).text, usage: normalizeUsage(data.usageMetadata?.promptTokenCount, data.usageMetadata?.candidatesTokenCount) }
    }
    return { text: TextEnvelopeSchema.parse({ text: data.message?.content }).text, usage: normalizeUsage(data.prompt_eval_count, data.eval_count) }
  } catch {
    throw new ProviderRequestError('Provider đã xử lý request nhưng phản hồi không đúng schema; usage hoặc chi phí có thể chưa đầy đủ.', 'invalid_response', 'confirmed', {
      requestId, httpStatus, retryCount, retryAt: null
    })
  }
}

function calculateCost(secret: ProviderSecret, usage: ProviderUsage): { estimatedCost: number; costStatus: CostStatus } {
  if (secret.kind === 'ollama') return { estimatedCost: 0, costStatus: 'not_applicable' }
  if (typeof secret.inputCostPerMillion !== 'number' || typeof secret.outputCostPerMillion !== 'number') return { estimatedCost: 0, costStatus: 'unknown' }
  return {
    estimatedCost: (usage.inputTokens * secret.inputCostPerMillion + usage.outputTokens * secret.outputCostPerMillion) / 1_000_000,
    costStatus: 'estimated'
  }
}

function normalizeUsage(input: unknown, output: unknown): ProviderUsage {
  return { inputTokens: Math.max(0, Math.trunc(Number(input) || 0)), outputTokens: Math.max(0, Math.trunc(Number(output) || 0)) }
}

function validateEndpoint(kind: ProviderSecret['kind'], value: string): void {
  const url = new URL(value)
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(kind === 'ollama' && url.protocol === 'http:' && isLoopback)) throw new Error('Endpoint phải dùng HTTPS; HTTP chỉ được phép với Ollama trên máy cục bộ.')
}

function parseRetryAfter(value: string | null): string | null {
  if (!value) return null
  const seconds = Number(value)
  const target = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1_000 : Date.parse(value)
  if (!Number.isFinite(target)) return null
  return new Date(Math.min(target, Date.now() + 60_000)).toISOString()
}

function exponentialBackoff(retryCount: number): number {
  return Math.min(30_000, 1_000 * (2 ** retryCount))
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createCancelledError(false))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createCancelledError(false))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function createCancelledError(submitted: boolean, requestId: string = randomUUID(), retryCount = 0): ProviderRequestError {
  return new ProviderRequestError(
    submitted ? 'Đã dừng chờ provider; request có thể đã phát sinh chi phí.' : 'Tác vụ đã được hủy trước khi gửi request.',
    'cancelled',
    submitted ? 'unknown' : 'not_billed',
    { requestId, httpStatus: null, retryCount, retryAt: null }
  )
}

function normalizeProviderError(error: unknown, requestId: string, retryCount: number): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error
  return new ProviderRequestError('Provider gặp lỗi không xác định.', 'network', 'unknown', { requestId, httpStatus: null, retryCount, retryAt: null })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function safeErrorMessage(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : 'Không thể kết nối provider.'
  return secret ? message.split(secret).join('[đã ẩn]') : message
}
