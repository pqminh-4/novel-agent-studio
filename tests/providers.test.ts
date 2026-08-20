import { describe, expect, it, vi } from 'vitest'
import {
  generateTextDetailed,
  ProviderConcurrencyLimiter,
  ProviderRequestError,
  type ProviderSecret
} from '@infra/index'

const secret: ProviderSecret = {
  kind: 'openai',
  apiKey: 'test-only-key',
  endpoint: 'https://provider.invalid',
  model: 'test-model',
  inputCostPerMillion: 2,
  outputCostPerMillion: 8
}

describe('live provider policy P0.3', () => {
  it('tôn trọng Retry-After cho 429 và ghi usage thật từ phản hồi thành công', async () => {
    const transport = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Chậm lại' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '2', 'x-request-id': 'request-rate-limit' }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output_text: 'OK',
        usage: { input_tokens: 125, output_tokens: 25 }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-success' }
      }))
    const delays: number[] = []
    const events: string[] = []

    const result = await generateTextDetailed(secret, 'Xin chào', {
      transport,
      sleep: async (milliseconds) => { delays.push(milliseconds) },
      onEvent: (event) => events.push(event.type)
    })

    expect(transport).toHaveBeenCalledTimes(2)
    expect(delays[0]).toBeGreaterThan(1_800)
    expect(result).toMatchObject({
      text: 'OK',
      requestId: 'request-success',
      retryCount: 1,
      usage: { inputTokens: 125, outputTokens: 25 },
      costStatus: 'estimated'
    })
    expect(result.estimatedCost).toBeCloseTo(0.00045)
    expect(events).toEqual(['submitted', 'retry_scheduled', 'submitted', 'response'])
  })

  it('không tự retry hoặc failover khi lỗi có khả năng đã phát sinh phí', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Lỗi upstream' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'x-request-id': 'request-uncertain' }
    }))

    const error = await generateTextDetailed(secret, 'Xin chào', { transport }).catch((cause) => cause)

    expect(transport).toHaveBeenCalledTimes(1)
    expect(error).toBeInstanceOf(ProviderRequestError)
    expect(error).toMatchObject({
      code: 'server_error',
      billingState: 'unknown',
      details: { requestId: 'request-uncertain', httpStatus: 503, retryCount: 0 }
    })
  })

  it('giới hạn request đồng thời cho từng provider', async () => {
    const limiter = new ProviderConcurrencyLimiter(1)
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const task = (): Promise<number> => limiter.run('openai', undefined, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      return peak
    })

    const first = task()
    const second = task()
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases.shift()?.()
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    releases.shift()?.()

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1])
    expect(peak).toBe(1)
  })
})
