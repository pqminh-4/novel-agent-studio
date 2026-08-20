import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableWorkflowEngine, NovelDatabase, ProviderRequestError, generateDeterministicArtifact } from '@infra/index'

const temporaryDirectories: string[] = []

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function createReadyDatabase(prefix: string): { directory: string; database: NovelDatabase; chapterId: string } {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  const database = new NovelDatabase(directory)
  const snapshot = database.getBootstrapSnapshot()
  database.approveOutlineVersion(snapshot.outlineVersions[0].id)
  return { directory, database, chapterId: snapshot.chapters[0].id }
}

describe('durable AI workflow P0.2–P0.4', () => {
  it('chạy đủ tám vai trò, giữ artifact đề xuất và chỉ commit sau khi duyệt', async () => {
    const { database, chapterId } = createReadyDatabase('novel-agent-workflow-success-')
    const original = database.getBootstrapSnapshot().chapters[0].content
    const originalCanonCount = database.getBootstrapSnapshot().canon.length
    const originalSummary = database.getBootstrapSnapshot().chapterSummaries.find((summary) => summary.chapterId === chapterId)
    const runId = database.startWorkflow(chapterId, 'balanced')
    const engine = new DurableWorkflowEngine(database, 0)

    expect(await engine.runUntilBlocked(runId)).toBe('waiting_review')
    let snapshot = database.getBootstrapSnapshot()
    const run = snapshot.workflowRuns.find((item) => item.id === runId)
    expect(new Set(run?.steps.map((step) => step.roleId))).toEqual(new Set([
      'director', 'architect', 'scene-planner', 'librarian', 'writer', 'editor', 'revision-adviser', 'visual-director'
    ]))
    expect(run?.steps.every((step) => step.status === 'completed')).toBe(true)
    expect(run?.artifacts).toHaveLength(10)
    expect(snapshot.reviewArtifacts).toHaveLength(10)
    expect(snapshot.chapters[0].content).toEqual(original)
    expect(snapshot.chapterSummaries.find((summary) => summary.chapterId === chapterId)).toEqual(originalSummary)

    const canonDelta = run?.artifacts.find((artifact) => artifact.kind === 'canon_delta')
    const approvedMemory = canonDelta?.data as {
      chapterSummary: string
      keyEvents: string[]
      unresolvedThreads: string[]
    }

    database.reviewWorkflow(runId, 'approve')
    snapshot = database.getBootstrapSnapshot()
    const completed = snapshot.workflowRuns.find((item) => item.id === runId)
    const committedSummary = snapshot.chapterSummaries.find((summary) => summary.chapterId === chapterId)
    expect(completed?.status).toBe('completed')
    expect(completed?.progress).toBe(100)
    expect(completed?.artifacts.some((artifact) => artifact.status === 'committed')).toBe(true)
    expect(snapshot.chapters[0].status).toBe('approved')
    expect(snapshot.chapters[0].content).not.toEqual(original)
    expect(snapshot.canon.length).toBe(originalCanonCount + 1)
    expect(committedSummary).toMatchObject({
      sourceVersion: (originalSummary?.sourceVersion ?? 0) + 1,
      summary: approvedMemory.chapterSummary,
      keyEvents: approvedMemory.keyEvents,
      unresolvedThreads: approvedMemory.unresolvedThreads
    })
    expect(() => database.reviewWorkflow(runId, 'approve')).toThrow('không còn ở trạng thái chờ duyệt')
    database.close()
  })

  it('từ chối workflow không commit bản thảo, canon hoặc chapter memory', async () => {
    const { database, chapterId } = createReadyDatabase('novel-agent-workflow-reject-memory-')
    const before = database.getBootstrapSnapshot()
    const originalChapter = before.chapters.find((chapter) => chapter.id === chapterId)!
    const originalSummary = before.chapterSummaries.find((summary) => summary.chapterId === chapterId)
    const runId = database.startWorkflow(chapterId, 'fast')
    const engine = new DurableWorkflowEngine(database, 0, (lease) => {
      const artifact = generateDeterministicArtifact(lease)
      if (lease.kind !== 'canon_delta') return artifact
      return {
        ...artifact,
        data: {
          ...artifact.data,
          chapterSummary: 'Tóm tắt này chỉ là đề xuất và không được phép ghi khi bị từ chối.',
          keyEvents: ['Sự kiện đề xuất chưa duyệt'],
          unresolvedThreads: ['Tuyến đề xuất chưa duyệt']
        }
      }
    })

    expect(await engine.runUntilBlocked(runId)).toBe('waiting_review')
    database.reviewWorkflow(runId, 'reject')
    const after = database.getBootstrapSnapshot()
    const rejectedRun = after.workflowRuns.find((run) => run.id === runId)

    expect(rejectedRun?.status).toBe('failed')
    expect(rejectedRun?.artifacts.every((artifact) => artifact.status === 'rejected')).toBe(true)
    expect(after.chapters.find((chapter) => chapter.id === chapterId)?.content).toEqual(originalChapter.content)
    expect(after.canon).toHaveLength(before.canon.length)
    expect(after.chapterSummaries.find((summary) => summary.chapterId === chapterId)).toEqual(originalSummary)
    database.close()
  })

  it('pause, resume và cancel không commit output dở dang', async () => {
    const { database, chapterId } = createReadyDatabase('novel-agent-workflow-control-')
    const original = database.getBootstrapSnapshot().chapters[0].content
    const engine = new DurableWorkflowEngine(database, 0)
    const pausedRunId = database.startWorkflow(chapterId, 'fast')

    database.pauseWorkflow(pausedRunId)
    expect(await engine.advance(pausedRunId)).toBe('paused')
    expect(database.getBootstrapSnapshot().workflowRuns[0].artifacts).toHaveLength(0)
    database.resumeWorkflow(pausedRunId)
    await engine.advance(pausedRunId)
    database.cancelWorkflow(pausedRunId)

    const cancelled = database.getBootstrapSnapshot().workflowRuns[0]
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.artifacts).toHaveLength(1)
    expect(database.getBootstrapSnapshot().chapters[0].content).toEqual(original)
    database.close()
  })

  it('đánh dấu interrupted sau restart rồi tiếp tục từ checkpoint', async () => {
    const { directory, database, chapterId } = createReadyDatabase('novel-agent-workflow-restart-')
    const runId = database.startWorkflow(chapterId, 'balanced')
    const firstEngine = new DurableWorkflowEngine(database, 0)
    await firstEngine.advance(runId)
    expect(database.getWorkflowRunStatus(runId)).toBe('running')
    database.close()

    const reopened = new NovelDatabase(directory)
    expect(reopened.getWorkflowRunStatus(runId)).toBe('interrupted')
    reopened.resumeWorkflow(runId)
    const resumedEngine = new DurableWorkflowEngine(reopened, 0)
    expect(await resumedEngine.runUntilBlocked(runId)).toBe('waiting_review')
    const run = reopened.getBootstrapSnapshot().workflowRuns.find((item) => item.id === runId)
    expect(run?.steps.every((step) => step.status === 'completed')).toBe(true)
    expect(run?.steps[0].attemptCount).toBe(1)
    reopened.close()
  })

  it('output sai schema chuyển failed và retry không tạo artifact trùng', async () => {
    const { database, chapterId } = createReadyDatabase('novel-agent-workflow-retry-')
    const runId = database.startWorkflow(chapterId, 'fast')
    const invalidEngine = new DurableWorkflowEngine(database, 0, (lease) => ({
      ...generateDeterministicArtifact(lease),
      data: {}
    }))

    expect(await invalidEngine.advance(runId)).toBe('failed')
    expect(database.getBootstrapSnapshot().workflowRuns[0].artifacts).toHaveLength(0)
    database.retryWorkflow(runId)
    const validEngine = new DurableWorkflowEngine(database, 0)
    expect(await validEngine.runUntilBlocked(runId)).toBe('waiting_review')
    const run = database.getBootstrapSnapshot().workflowRuns[0]
    expect(run.steps[0].attemptCount).toBe(2)
    expect(new Set(run.artifacts.map((artifact) => artifact.stepId)).size).toBe(run.artifacts.length)
    database.close()
  })

  it('preset Chất lượng commit đúng bản sửa cuối rồi mới commit canon', async () => {
    const { database, chapterId } = createReadyDatabase('novel-agent-workflow-quality-')
    const runId = database.startWorkflow(chapterId, 'quality')
    const engine = new DurableWorkflowEngine(database, 0, (lease) => {
      const artifact = generateDeterministicArtifact(lease)
      if (lease.kind !== 'revised_draft') return artifact
      const document = artifact.data.document as { type: 'doc'; content: Record<string, unknown>[] }
      const marker = `Bản sửa tại checkpoint ${lease.ordinal + 1}`
      return {
        ...artifact,
        data: {
          ...artifact.data,
          document: {
            ...document,
            content: [...document.content, { type: 'paragraph', content: [{ type: 'text', text: marker }] }]
          },
          wordCount: Number(artifact.data.wordCount) + marker.split(/\s+/).length
        }
      }
    })

    expect(await engine.runUntilBlocked(runId)).toBe('waiting_review')
    const waitingRun = database.getBootstrapSnapshot().workflowRuns.find((run) => run.id === runId)
    const revisions = waitingRun?.artifacts.filter((artifact) => artifact.kind === 'revised_draft') ?? []
    expect(waitingRun?.artifacts).toHaveLength(13)
    expect(revisions).toHaveLength(2)
    expect(waitingRun?.artifacts.at(-2)?.kind).toBe('canon_delta')
    expect(waitingRun?.artifacts.at(-1)?.kind).toBe('visual_note')

    const finalRevision = revisions.at(-1)
    const canonDelta = waitingRun?.artifacts.find((artifact) => artifact.kind === 'canon_delta')
    database.reviewWorkflow(runId, 'approve')
    const completedSnapshot = database.getBootstrapSnapshot()
    const completedRun = completedSnapshot.workflowRuns.find((run) => run.id === runId)
    expect(completedSnapshot.chapters[0].content).toEqual(finalRevision?.data.document)
    expect(completedRun?.artifacts.filter((artifact) => artifact.status === 'committed').map((artifact) => artifact.id)).toEqual([
      finalRevision?.id,
      canonDelta?.id
    ])
    expect(completedRun?.artifacts.filter((artifact) => artifact.kind === 'revised_draft').map((artifact) => artifact.status)).toEqual([
      'approved',
      'committed'
    ])
    expect(completedRun?.artifacts.find((artifact) => artifact.kind === 'draft')?.status).toBe('approved')
    database.close()
  })

  it('dừng ở billing_unknown và chỉ tạo attempt mới sau retry thủ công', async () => {
    const { database, chapterId } = createReadyDatabase('novel-agent-workflow-billing-')
    const runId = database.startWorkflow(chapterId, 'fast', [{
      roleId: 'director',
      provider: 'openai',
      model: 'test-model',
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      contextTokenBudget: 16_000
    }])
    const uncertainEngine = new DurableWorkflowEngine(database, 0, () => {
      throw new ProviderRequestError('Mất kết nối sau khi gửi request.', 'network', 'unknown', {
        requestId: 'request-billing-unknown',
        httpStatus: null,
        retryCount: 0,
        retryAt: null
      })
    })

    expect(await uncertainEngine.advance(runId)).toBe('billing_unknown')
    let run = database.getBootstrapSnapshot().workflowRuns[0]
    expect(run.status).toBe('billing_unknown')
    expect(run.steps[0]).toMatchObject({
      status: 'billing_unknown',
      billingState: 'unknown',
      requestId: 'request-billing-unknown',
      attemptCount: 1
    })
    expect(run.artifacts).toHaveLength(0)

    database.retryWorkflow(runId)
    run = database.getBootstrapSnapshot().workflowRuns[0]
    expect(run.status).toBe('queued')
    expect(run.steps[0]).toMatchObject({ status: 'pending', attemptCount: 1, requestId: null })
    database.close()
  })

  it('khởi động lại sau khi đã submit live request không tự chạy trùng', () => {
    const { directory, database, chapterId } = createReadyDatabase('novel-agent-workflow-live-restart-')
    const runId = database.startWorkflow(chapterId, 'fast', [{
      roleId: 'director',
      provider: 'openai',
      model: 'test-model',
      inputCostPerMillion: null,
      outputCostPerMillion: null,
      contextTokenBudget: 16_000
    }])
    const lease = database.claimWorkflowStep(runId)
    expect(lease).not.toBeNull()
    database.recordWorkflowProviderEvent(lease!, {
      type: 'submitted',
      requestId: 'request-before-restart',
      retryCount: 0,
      httpStatus: null,
      retryAt: null,
      billingState: 'unknown'
    })
    database.close()

    const reopened = new NovelDatabase(directory)
    const run = reopened.getBootstrapSnapshot().workflowRuns.find((item) => item.id === runId)
    expect(run).toMatchObject({ status: 'billing_unknown', costStatus: 'unknown' })
    expect(run?.steps[0]).toMatchObject({
      status: 'billing_unknown',
      requestId: 'request-before-restart',
      billingState: 'unknown'
    })
    reopened.close()
  })

  it('dùng tóm tắt chương đã duyệt, khóa context packet và giữ budget qua restart', async () => {
    const { directory, database } = createReadyDatabase('novel-agent-workflow-context-')
    const snapshot = database.getBootstrapSnapshot()
    const chapterOne = snapshot.chapters.find((chapter) => chapter.number === 1)!
    const chapterTwo = snapshot.chapters.find((chapter) => chapter.number === 2)!
    const firstRun = database.startWorkflow(chapterOne.id, 'fast')
    const engine = new DurableWorkflowEngine(database, 0)
    expect(await engine.runUntilBlocked(firstRun)).toBe('waiting_review')
    database.reviewWorkflow(firstRun, 'approve')

    const secondRun = database.startWorkflow(chapterTwo.id, 'balanced', [{
      roleId: 'librarian',
      provider: 'demo',
      model: 'deterministic-v1',
      inputCostPerMillion: null,
      outputCostPerMillion: null,
      contextTokenBudget: 2_000
    }])
    database.close()

    const reopened = new NovelDatabase(directory)
    expect(reopened.getWorkflowRunStatus(secondRun)).toBe('interrupted')
    reopened.resumeWorkflow(secondRun)
    const observedPackets: Array<{ kind: string; packet: unknown }> = []
    const resumedEngine = new DurableWorkflowEngine(reopened, 0, (lease) => {
      observedPackets.push({ kind: lease.kind, packet: lease.contextPacket })
      return generateDeterministicArtifact(lease)
    })
    for (let index = 0; index < 4; index += 1) await resumedEngine.advance(secondRun)
    const run = reopened.getBootstrapSnapshot().workflowRuns.find((item) => item.id === secondRun)
    const contextArtifact = run?.artifacts.find((artifact) => artifact.kind === 'context_packet')

    expect(contextArtifact?.data.chapterSummaryIds).toContain(`summary:${chapterOne.id}`)
    expect(contextArtifact?.data.provenance).toEqual(expect.arrayContaining([expect.stringContaining(`chapter-summary:${chapterOne.id}`)]))
    expect(contextArtifact?.data.budget).toMatchObject({ limit: 2_000 })
    expect(Number((contextArtifact?.data.budget as { used: number }).used)).toBeLessThanOrEqual(2_000)

    reopened.saveChapter(chapterOne.id, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nguồn chương cũ đã thay đổi sau khi context checkpoint được khóa.' }] }]
    }, 11)
    await resumedEngine.advance(secondRun)
    const checkpointPacket = observedPackets.find((entry) => entry.kind === 'context_packet')?.packet as { sources: unknown[] }
    const writerPacket = observedPackets.find((entry) => entry.kind === 'draft')?.packet as { sources: unknown[]; budget: { limit: number } }

    expect(writerPacket.sources).toEqual(checkpointPacket.sources)
    expect(writerPacket.budget.limit).toBe(16_000)
    reopened.close()
  })
})
