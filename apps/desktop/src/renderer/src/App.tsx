import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import {
  Archive,
  BookOpenText,
  BookPlus,
  Bold,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cloud,
  DatabaseBackup,
  Download,
  Edit3,
  FileArchive,
  FileText,
  FolderPlus,
  GalleryVerticalEnd,
  Image,
  Italic,
  LibraryBig,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Moon,
  MoreHorizontal,
  PanelRightClose,
  Pause,
  Play,
  Plus,
  Quote,
  Redo2,
  RotateCcw,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Undo2,
  Upload,
  UsersRound,
  WandSparkles,
  Wifi,
  X
} from 'lucide-react'
import {
  getWorkflowSteps,
  type BootstrapSnapshot,
  type Book,
  type Chapter,
  type OutlineVersion,
  type ProviderConnection,
  type ProviderKind,
  type ProviderRoute,
  type RecoveryStatus,
  type RoleProfile,
  type Series,
  type WorkflowArtifact,
  type WorkflowPreset,
  type WorkflowRun
} from '@core/index'

type Workspace = 'manuscript' | 'outline' | 'canon' | 'agents' | 'visual' | 'settings'
type InspectorTab = 'brief' | 'canon' | 'research'
type Toast = { id: number; message: string; tone: 'success' | 'danger' | 'neutral' }

const DEFAULT_ENDPOINTS: Record<Exclude<ProviderKind, 'demo'>, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  ollama: 'http://127.0.0.1:11434'
}

const DEFAULT_MODELS: Record<Exclude<ProviderKind, 'demo'>, string> = {
  openai: 'gpt-5.4-mini',
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-3.1-pro-preview',
  ollama: 'qwen3:8b'
}

export function App(): ReactNode {
  const [snapshot, setSnapshot] = useState<BootstrapSnapshot | null>(null)
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null)
  const [workspace, setWorkspace] = useState<Workspace>('manuscript')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('brief')
  const [selectedChapterId, setSelectedChapterId] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [projectManagerOpen, setProjectManagerOpen] = useState(false)
  const [chapterEditor, setChapterEditor] = useState<Chapter | 'new' | null>(null)
  const [workflowCenterOpen, setWorkflowCenterOpen] = useState(false)
  const workflowPollErrorNotified = useRef(false)

  const loadSnapshot = useCallback(async () => {
    try {
      const status = await window.novelAgent.recovery.status()
      setRecoveryStatus(status)
      if (status.safeMode) {
        setSnapshot(null)
        setError(null)
        return
      }
      const data = await window.novelAgent.invoke<BootstrapSnapshot>('app:bootstrap')
      setSnapshot(data)
      setSelectedChapterId((current) => current || data.chapters[0]?.id || '')
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể mở workspace.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const toast = useCallback((message: string, tone: Toast['tone'] = 'neutral') => {
    const id = Date.now()
    setToasts((items) => [...items, { id, message, tone }])
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3600)
  }, [])

  const adoptSnapshot = useCallback((data: BootstrapSnapshot, chapterId?: string) => {
    setSnapshot(data)
    setSelectedChapterId((current) => {
      if (chapterId && data.chapters.some((chapter) => chapter.id === chapterId)) return chapterId
      if (data.chapters.some((chapter) => chapter.id === current)) return current
      return data.chapters[0]?.id ?? ''
    })
  }, [])

  const activeWorkflowCount = snapshot?.workflowRuns.filter((run) => run.status === 'queued' || run.status === 'running').length ?? 0

  useEffect(() => {
    if (activeWorkflowCount === 0) {
      workflowPollErrorNotified.current = false
      return
    }
    let cancelled = false
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      try {
        const updated = await window.novelAgent.invoke<BootstrapSnapshot>('app:bootstrap')
        if (!cancelled) {
          adoptSnapshot(updated)
          workflowPollErrorNotified.current = false
        }
      } catch (cause) {
        if (!cancelled && !workflowPollErrorNotified.current) {
          workflowPollErrorNotified.current = true
          toast(cause instanceof Error ? cause.message : 'Không thể đồng bộ tiến độ workflow.', 'danger')
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 500)
      }
    }
    timer = window.setTimeout(() => void poll(), 500)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [activeWorkflowCount, adoptSnapshot, toast])

  if (loading) return <LoadingScreen />
  if (recoveryStatus?.safeMode) return <RecoverySafeMode status={recoveryStatus} onRefresh={loadSnapshot} />
  if (error || !snapshot) return <ErrorScreen message={error ?? 'Workspace không có dữ liệu.'} onRetry={loadSnapshot} />

  const selectedChapter = snapshot.chapters.find((chapter) => chapter.id === selectedChapterId) ?? snapshot.chapters[0]

  return (
    <div className="app" data-inspector={inspectorOpen ? 'open' : 'closed'}>
      <TitleBar />
      <AppRail workspace={workspace} onChange={setWorkspace} />
      <ProjectSidebar
        snapshot={snapshot}
        selectedChapterId={selectedChapter?.id ?? ''}
        onSelectChapter={(id) => {
          setSelectedChapterId(id)
          setWorkspace('manuscript')
        }}
        onManageProjects={() => setProjectManagerOpen(true)}
        onCreateChapter={() => setChapterEditor('new')}
        onManageChapter={(chapter) => setChapterEditor(chapter)}
        onSwitchBook={async (bookId) => {
          try {
            const data = await window.novelAgent.invoke<BootstrapSnapshot>('workspace:switch-book', { bookId })
            adoptSnapshot(data)
          } catch (cause) {
            toast(cause instanceof Error ? cause.message : 'Không thể mở sách.', 'danger')
          }
        }}
      />
      <main className="workspace">
        <WorkspaceHeader
          snapshot={snapshot}
          workspace={workspace}
          theme={theme}
          inspectorOpen={inspectorOpen}
          onTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
          onInspector={() => setInspectorOpen((value) => !value)}
          onBackup={async () => {
            try {
              const result = await window.novelAgent.backup()
              if (result) toast(`Đã tạo backup an toàn · schema v${result.inspection.schemaVersion}`, 'success')
            } catch (cause) {
              toast(cause instanceof Error ? cause.message : 'Không thể tạo backup.', 'danger')
            }
          }}
          onExport={async (format) => {
            const result = await window.novelAgent.exportBook(format)
            if (result) toast(`Đã xuất bản thảo tới ${result.path}`, 'success')
          }}
        />
        <WorkspaceErrorBoundary resetKey={workspace}>
          <WorkspaceContent
            workspace={workspace}
            snapshot={snapshot}
            selectedChapter={selectedChapter}
            onSnapshot={adoptSnapshot}
            onChapterSaved={(chapter) => {
              setSnapshot((current) => current ? {
                ...current,
                chapters: current.chapters.map((item) => item.id === chapter.id ? chapter : item)
              } : current)
            }}
            onToast={toast}
            onCreateChapter={() => setChapterEditor('new')}
            onOpenWorkflow={() => setWorkflowCenterOpen(true)}
          />
        </WorkspaceErrorBoundary>
      </main>
      {inspectorOpen && (
        <Inspector
          snapshot={snapshot}
          tab={inspectorTab}
          onTab={setInspectorTab}
          onClose={() => setInspectorOpen(false)}
        />
      )}
      <JobTray snapshot={snapshot} onOpen={() => setWorkflowCenterOpen(true)} />
      <ToastStack items={toasts} />
      {projectManagerOpen && (
        <ProjectManagerDialog
          snapshot={snapshot}
          onClose={() => setProjectManagerOpen(false)}
          onSnapshot={(data) => adoptSnapshot(data)}
          onToast={toast}
        />
      )}
      {chapterEditor && (
        <ChapterDialog
          bookId={snapshot.activeBook.id}
          chapter={chapterEditor === 'new' ? undefined : chapterEditor}
          onClose={() => setChapterEditor(null)}
          onSnapshot={(data, chapterId) => adoptSnapshot(data, chapterId)}
          onToast={toast}
        />
      )}
      {workflowCenterOpen && (
        <WorkflowCenterDialog
          snapshot={snapshot}
          onClose={() => setWorkflowCenterOpen(false)}
          onSnapshot={adoptSnapshot}
          onToast={toast}
        />
      )}
    </div>
  )
}

function TitleBar(): ReactNode {
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="brand-mark"><GalleryVerticalEnd size={14} /></span>
        <span>Novel Agent Studio</span>
        <span className="titlebar__version">PREVIEW 0.1</span>
      </div>
      <div className="titlebar__status"><span className="status-dot status-dot--good" /> Local-first · Đã lưu</div>
    </header>
  )
}

function AppRail({ workspace, onChange }: { workspace: Workspace; onChange: (value: Workspace) => void }): ReactNode {
  const items: Array<{ id: Workspace; label: string; icon: ReactNode }> = [
    { id: 'manuscript', label: 'Bản thảo', icon: <BookOpenText size={19} /> },
    { id: 'outline', label: 'Dàn ý', icon: <ListTree size={19} /> },
    { id: 'canon', label: 'Story Bible', icon: <LibraryBig size={19} /> },
    { id: 'agents', label: 'AI Studio', icon: <BrainCircuit size={19} /> },
    { id: 'visual', label: 'Visual Studio', icon: <Image size={19} /> }
  ]
  return (
    <nav className="app-rail" aria-label="Khu vực chính">
      <div className="app-rail__primary">
        {items.map((item) => (
          <button key={item.id} className="rail-button" data-active={workspace === item.id} onClick={() => onChange(item.id)} aria-label={item.label} title={item.label}>
            {item.icon}
            <span className="rail-button__indicator" />
          </button>
        ))}
      </div>
      <button className="rail-button" data-active={workspace === 'settings'} onClick={() => onChange('settings')} aria-label="Cài đặt" title="Cài đặt">
        <Settings size={19} />
        <span className="rail-button__indicator" />
      </button>
    </nav>
  )
}

function ProjectSidebar({
  snapshot,
  selectedChapterId,
  onSelectChapter,
  onManageProjects,
  onCreateChapter,
  onManageChapter,
  onSwitchBook
}: {
  snapshot: BootstrapSnapshot
  selectedChapterId: string
  onSelectChapter: (id: string) => void
  onManageProjects: () => void
  onCreateChapter: () => void
  onManageChapter: (chapter: Chapter) => void
  onSwitchBook: (bookId: string) => void
}): ReactNode {
  const progress = Math.round((snapshot.activeBook.approvedChapters / snapshot.activeBook.targetChapters) * 100)
  const activeSeries = snapshot.series.find((series) => series.id === snapshot.activeBook.seriesId)
  return (
    <aside className="project-sidebar">
      <div className="sidebar-topline">
        <span>DỰ ÁN</span>
        <button className="icon-button" onClick={onManageProjects} aria-label="Quản lý dự án" title="Quản lý series và sách"><Plus size={15} /></button>
      </div>
      <button className="series-card" onClick={onManageProjects} aria-label="Mở quản lý dự án">
        <div className="series-card__cover"><span>{initials(activeSeries?.name ?? 'NA')}</span></div>
        <div className="series-card__copy">
          <strong>{activeSeries?.name}</strong>
          <span>{activeSeries?.bookCount ?? 0} sách · Quản lý dự án</span>
        </div>
        <ChevronDown size={15} />
      </button>
      <div className="book-summary">
        <div className="book-summary__label"><span>SÁCH ĐANG MỞ</span><span>{progress}%</span></div>
        <label className="book-switcher">
          <span className="sr-only">Chọn sách</span>
          <select value={snapshot.activeBook.id} onChange={(event) => onSwitchBook(event.target.value)}>
            {snapshot.series.map((series) => (
              <optgroup label={series.name} key={series.id}>
                {snapshot.books.filter((book) => book.seriesId === series.id).map((book) => <option value={book.id} key={book.id}>{book.title}</option>)}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <p>{snapshot.activeBook.genre}</p>
        <div className="progress-track"><span style={{ width: `${Math.max(progress, 4)}%` }} /></div>
      </div>
      <div className="chapter-heading">
        <span>CHƯƠNG</span>
        <button className="icon-button" onClick={onCreateChapter} aria-label="Tạo chương"><Plus size={14} /></button>
      </div>
      <div className="chapter-list">
        {snapshot.chapters.map((chapter) => (
          <div className="chapter-row-shell" key={chapter.id} data-active={selectedChapterId === chapter.id}>
            <button className="chapter-row" onClick={() => onSelectChapter(chapter.id)}>
              <span className={`chapter-state chapter-state--${chapter.status}`} />
              <span className="chapter-number">{String(chapter.number).padStart(2, '0')}</span>
              <span className="chapter-title">{chapter.title}</span>
              {selectedChapterId === chapter.id && <ChevronRight size={13} />}
            </button>
            <button className="chapter-manage" onClick={() => onManageChapter(chapter)} aria-label={`Quản lý chương ${chapter.number}`} title="Sửa hoặc lưu trữ chương"><MoreHorizontal size={14} /></button>
          </div>
        ))}
        {snapshot.chapters.length === 0 && <div className="chapter-empty">Sách này chưa có chương.</div>}
      </div>
      <button className="sidebar-action" onClick={onCreateChapter}><Plus size={14} /> Thêm chương</button>
    </aside>
  )
}

type WorkspaceHeaderProps = {
  snapshot: BootstrapSnapshot
  workspace: Workspace
  theme: 'dark' | 'light'
  inspectorOpen: boolean
  onTheme: () => void
  onInspector: () => void
  onBackup: () => void
  onExport: (format: 'markdown' | 'docx' | 'epub' | 'pdf') => void
}

function WorkspaceHeader(props: WorkspaceHeaderProps): ReactNode {
  const [exportOpen, setExportOpen] = useState(false)
  const activeSeries = props.snapshot.series.find((series) => series.id === props.snapshot.activeBook.seriesId)
  const labels: Record<Workspace, string> = {
    manuscript: 'Manuscript Studio',
    outline: 'Xưởng dàn ý',
    canon: 'Story Bible',
    agents: 'AI Studio',
    visual: 'Visual Studio',
    settings: 'Cài đặt'
  }
  return (
    <div className="workspace-header">
      <div>
        <div className="eyebrow">{activeSeries?.name} / {props.snapshot.activeBook.title}</div>
        <h1>{labels[props.workspace]}</h1>
      </div>
      <div className="workspace-actions">
        <button className="icon-button icon-button--bordered" disabled aria-label="Tìm kiếm" title="Tìm kiếm toàn văn sẽ có trong sprint sau"><Search size={16} /></button>
        <button className="icon-button icon-button--bordered" onClick={props.onTheme} aria-label="Đổi giao diện" title="Đổi giao diện">
          {props.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button className="icon-button icon-button--bordered" onClick={props.onBackup} aria-label="Sao lưu" title="Sao lưu"><Archive size={16} /></button>
        <div className="menu-anchor">
          <button className="button button--secondary" onClick={() => setExportOpen((value) => !value)}><Download size={15} /> Xuất bản <ChevronDown size={13} /></button>
          {exportOpen && (
            <div className="popover export-menu">
              {(['docx', 'epub', 'pdf', 'markdown'] as const).map((format) => (
                <button key={format} onClick={() => { setExportOpen(false); props.onExport(format) }}>
                  <FileText size={15} /><span><strong>{format === 'markdown' ? 'Markdown' : format.toUpperCase()}</strong><small>{exportDescription(format)}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-button icon-button--bordered" onClick={props.onInspector} aria-label="Bật tắt bảng thông tin" title="Bảng thông tin">
          <PanelRightClose size={16} style={{ transform: props.inspectorOpen ? 'none' : 'rotate(180deg)' }} />
        </button>
      </div>
    </div>
  )
}

function WorkspaceContent(props: {
  workspace: Workspace
  snapshot: BootstrapSnapshot
  selectedChapter?: Chapter
  onSnapshot: (value: BootstrapSnapshot) => void
  onChapterSaved: (chapter: Chapter) => void
  onToast: (message: string, tone?: Toast['tone']) => void
  onCreateChapter: () => void
  onOpenWorkflow: () => void
}): ReactNode {
  switch (props.workspace) {
    case 'manuscript':
      return <ManuscriptStudio {...props} />
    case 'outline':
      return <OutlineStudio snapshot={props.snapshot} onSnapshot={props.onSnapshot} onToast={props.onToast} />
    case 'canon':
      return <CanonStudio snapshot={props.snapshot} />
    case 'agents':
      return <AgentStudio snapshot={props.snapshot} selectedChapter={props.selectedChapter} onSnapshot={props.onSnapshot} onToast={props.onToast} onOpenWorkflow={props.onOpenWorkflow} />
    case 'visual':
      return <VisualStudio />
    case 'settings':
      return <SettingsStudio snapshot={props.snapshot} onToast={props.onToast} />
  }
}

function ManuscriptStudio({ snapshot, selectedChapter, onSnapshot, onChapterSaved, onToast, onCreateChapter }: {
  snapshot: BootstrapSnapshot
  selectedChapter?: Chapter
  onSnapshot: (value: BootstrapSnapshot) => void
  onChapterSaved: (chapter: Chapter) => void
  onToast: (message: string, tone?: Toast['tone']) => void
  onCreateChapter: () => void
}): ReactNode {
  const [mode, setMode] = useState<'write' | 'director'>('write')
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const saveTimer = useRef<number | null>(null)
  const activeChapterId = useRef(selectedChapter?.id)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Placeholder.configure({ placeholder: 'Bắt đầu viết cảnh này…' })
    ],
    content: selectedChapter?.content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: {
      attributes: {
        class: 'manuscript-editor',
        spellcheck: 'true',
        'aria-label': 'Nội dung chương'
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      if (!activeChapterId.current) return
      // Chương có nội dung hỏng ở chế độ chỉ đọc: main process sẽ từ chối lưu,
      // nên không hẹn autosave để tránh báo lỗi liên tục khi người dùng gõ.
      if (selectedChapter?.contentCorrupt) return
      setSaveState('dirty')
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(async () => {
        setSaveState('saving')
        try {
          const text = currentEditor.getText().trim()
          const wordCount = text ? text.split(/\s+/).length : 0
          const saved = await window.novelAgent.invoke<Chapter>('chapter:save', {
            chapterId: activeChapterId.current,
            content: currentEditor.getJSON(),
            wordCount
          })
          onChapterSaved(saved)
          setSaveState('saved')
        } catch (error) {
          setSaveState('dirty')
          onToast(error instanceof Error ? error.message : 'Không thể lưu chương.', 'danger')
        }
      }, 750)
    }
  })

  useEffect(() => {
    if (!editor || !selectedChapter) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    activeChapterId.current = selectedChapter.id
    editor.commands.setContent(selectedChapter.content)
    setSaveState('saved')
  }, [editor, selectedChapter?.id])

  if (!editor) return <LoadingPanel label="Đang mở chương…" />
  if (!selectedChapter) {
    return <div className="empty-studio"><BookOpenText size={30} /><h2>Bắt đầu chương đầu tiên</h2><p>Sách đã sẵn sàng. Tạo một chương để mở không gian viết và autosave cục bộ.</p><button className="button button--primary" onClick={onCreateChapter}><Plus size={15} /> Tạo chương</button></div>
  }

  return (
    <div className="manuscript-layout">
      <div className="mode-tabs" role="tablist" aria-label="Chế độ làm việc">
        <button role="tab" aria-selected={mode === 'write'} data-active={mode === 'write'} onClick={() => setMode('write')}><FileText size={14} /> Viết</button>
        <button role="tab" aria-selected={mode === 'director'} data-active={mode === 'director'} onClick={() => setMode('director')}><MessageSquareText size={14} /> Trò chuyện với Đạo diễn</button>
      </div>
      {mode === 'write' ? (
        <div className="editor-shell">
          <div className="editor-toolbar">
            <div className="toolbar-group">
              <button onClick={() => editor.chain().focus().toggleBold().run()} data-active={editor.isActive('bold')} aria-label="In đậm"><Bold size={15} /></button>
              <button onClick={() => editor.chain().focus().toggleItalic().run()} data-active={editor.isActive('italic')} aria-label="In nghiêng"><Italic size={15} /></button>
              <button onClick={() => editor.chain().focus().toggleBlockquote().run()} data-active={editor.isActive('blockquote')} aria-label="Trích dẫn"><Quote size={15} /></button>
            </div>
            <div className="toolbar-group">
              <button onClick={() => editor.chain().focus().undo().run()} aria-label="Hoàn tác"><Undo2 size={15} /></button>
              <button onClick={() => editor.chain().focus().redo().run()} aria-label="Làm lại"><Redo2 size={15} /></button>
            </div>
            <div className="editor-toolbar__meta">
              <span>{editor.getText().trim() ? editor.getText().trim().split(/\s+/).length : 0} từ</span>
              <span className={`save-state save-state--${saveState}`}>
                {saveState === 'saving' ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
                {saveState === 'saved' ? 'Đã lưu' : saveState === 'saving' ? 'Đang lưu' : 'Chưa lưu'}
              </span>
            </div>
          </div>
          {selectedChapter.contentCorrupt ? (
            <div className="notice notice--danger" role="alert">
              <ShieldCheck size={14} />
              <div>
                <strong>Nội dung chương này đã hỏng và đang ở chế độ chỉ đọc.</strong>
                <p>Bản gốc trong cơ sở dữ liệu được giữ nguyên, không bị ghi đè. Hãy khôi phục từ lịch sử phiên bản hoặc từ bản sao lưu trong Data Safety trước khi sửa tiếp.</p>
              </div>
            </div>
          ) : null}
          <article className="paper">
            <div className="paper__chapter">CHƯƠNG {String(selectedChapter.number).padStart(2, '0')}</div>
            <input className="paper__title" value={selectedChapter.title} readOnly aria-label="Tiêu đề chương" />
            <EditorContent editor={editor} />
          </article>
          <div className="writing-footer">
            <span><Clock3 size={13} /> Cập nhật {relativeTime(selectedChapter.updatedAt)}</span>
            <span><ShieldCheck size={13} /> Bản thảo chỉ lưu trên máy này</span>
          </div>
        </div>
      ) : (
        <DirectorChat snapshot={snapshot} onSnapshot={onSnapshot} onToast={onToast} />
      )}
    </div>
  )
}

function DirectorChat({ snapshot, onSnapshot, onToast }: { snapshot: BootstrapSnapshot; onSnapshot: (value: BootstrapSnapshot) => void; onToast: (message: string, tone?: Toast['tone']) => void }): ReactNode {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [activeProvider, setActiveProvider] = useState<Exclude<ProviderKind, 'demo'> | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [snapshot.messages.length])
  useEffect(() => { void window.novelAgent.vault.preferred().then(setActiveProvider) }, [])

  const send = async (): Promise<void> => {
    if (!input.trim() || sending) return
    const content = input.trim()
    setInput('')
    setSending(true)
    try {
      const updated = await window.novelAgent.invoke<BootstrapSnapshot>('director:message', { bookId: snapshot.activeBook.id, content })
      onSnapshot(updated)
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Không thể gửi tin nhắn.', 'danger')
      setInput(content)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="chat-panel">
      <div className="chat-intro">
        <div className="agent-avatar agent-avatar--director"><WandSparkles size={18} /></div>
        <div><h2>Đạo diễn truyện</h2><p>{activeProvider ? providerName(activeProvider) : 'Demo cục bộ'} · {snapshot.readiness}% sẵn sàng</p></div>
        <div className="readiness-orb" style={{ '--value': `${snapshot.readiness * 3.6}deg` } as React.CSSProperties}><span>{snapshot.readiness}</span></div>
      </div>
      <div className="message-list">
        {snapshot.messages.map((message) => (
          <div key={message.id} className="message" data-role={message.role}>
              {message.role !== 'user' && <div className="message__avatar">{message.role === 'system' ? <ShieldCheck size={14} /> : <Sparkles size={14} />}</div>}
              <div className="message__bubble">
              {message.role !== 'user' && <strong>{message.role === 'system' ? 'Hệ thống' : 'Đạo diễn'}</strong>}
              <p>{message.content}</p>
              <time>{formatTime(message.createdAt)}</time>
            </div>
          </div>
        ))}
        {sending && <div className="message"><div className="message__avatar"><Sparkles size={14} /></div><div className="message__bubble typing"><span /><span /><span /></div></div>}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
          }}
          placeholder="Kể cho Đạo diễn điều bạn hình dung…"
          rows={3}
        />
        <div className="composer__footer">
          <span>Enter để gửi · Shift+Enter xuống dòng</span>
          <button className="send-button" onClick={() => void send()} disabled={!input.trim() || sending} aria-label="Gửi tin nhắn"><Send size={15} /></button>
        </div>
      </div>
    </section>
  )
}

function OutlineStudio({ snapshot, onSnapshot, onToast }: {
  snapshot: BootstrapSnapshot
  onSnapshot: (value: BootstrapSnapshot) => void
  onToast: (message: string, tone?: Toast['tone']) => void
}): ReactNode {
  const [selectedVersionId, setSelectedVersionId] = useState(snapshot.outlineVersions[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const selectedVersion = snapshot.outlineVersions.find((version) => version.id === selectedVersionId) ?? snapshot.outlineVersions[0]

  useEffect(() => {
    if (!snapshot.outlineVersions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(snapshot.outlineVersions[0]?.id ?? '')
    }
  }, [selectedVersionId, snapshot.outlineVersions])

  const mutate = async (channel: string, payload: unknown, successMessage: string): Promise<void> => {
    setBusy(true)
    try {
      const updated = await window.novelAgent.invoke<BootstrapSnapshot>(channel, payload)
      onSnapshot(updated)
      setSelectedVersionId(updated.outlineVersions[0]?.id ?? '')
      onToast(successMessage, 'success')
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'Không thể cập nhật dàn ý.', 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="studio-page">
      <section className="page-lead">
        <div><span className="eyebrow">BLUEPRINT · {selectedVersion ? `PHIÊN BẢN ${String(selectedVersion.version).padStart(2, '0')}` : 'CHƯA CÓ PHIÊN BẢN'}</span><h2>Nhịp truyện đang hình thành</h2><p>Dàn ý chỉ trở thành nguồn viết sau khi được bạn duyệt. Mọi lần tạo lại và khôi phục đều giữ nguyên lịch sử.</p></div>
        <button className="button button--primary" disabled={busy} onClick={() => void mutate('outline:create-proposal', { bookId: snapshot.activeBook.id }, 'Đã tạo một đề xuất dàn ý mới.')}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} Kiến trúc sư đề xuất
        </button>
      </section>
      <div className="outline-board">
        <div className="act-column">
          <div className="act-header"><span>DÀN Ý ĐANG XEM</span><strong>{selectedVersion ? outlineStatusLabel(selectedVersion) : 'Chưa có đề xuất'}</strong><small>{selectedVersion?.chapters.length ?? 0} chương · {selectedVersion ? formatDateTime(selectedVersion.createdAt) : 'Hãy tạo đề xuất đầu tiên'}</small></div>
          {selectedVersion?.chapters.map((chapter, index) => (
            <article className="outline-card" key={chapter.number} style={{ '--delay': `${index * 36}ms` } as React.CSSProperties}>
              <div className="outline-card__number">{String(chapter.number).padStart(2, '0')}</div>
              <div><h3>{chapter.title}</h3><p>{chapter.purpose}</p><div className="tag-row"><span>1–3 cảnh</span><span>{chapter.status === 'ready' ? 'Sẵn sàng' : 'Đã lên kế hoạch'}</span></div></div>
              <button className="icon-button" disabled aria-label="Tùy chọn chương dàn ý" title="Chỉnh từng mục dàn ý sẽ có trong sprint sau"><MoreHorizontal size={15} /></button>
            </article>
          ))}
          {!selectedVersion && <div className="outline-empty"><ListTree size={26} /><h3>Chưa có dàn ý</h3><p>Kiến trúc sư sẽ dùng brief hiện tại để tạo phiên bản đầu tiên.</p></div>}
        </div>
        <aside className="outline-history">
          <div className="outline-history__head"><div><span className="panel-kicker">LỊCH SỬ PHIÊN BẢN</span><h3>{snapshot.outlineVersions.length} phiên bản</h3></div><ShieldCheck size={18} /></div>
          <div className="version-list">
            {snapshot.outlineVersions.map((version) => (
              <button className="version-row" data-active={version.id === selectedVersion?.id} onClick={() => setSelectedVersionId(version.id)} key={version.id}>
                <span className={`version-badge version-badge--${version.status}`}>V{version.version}</span>
                <span><strong>{outlineStatusLabel(version)}</strong><small>{formatDateTime(version.createdAt)}</small></span>
                {version.approvedAt && <Check size={14} />}
              </button>
            ))}
          </div>
          {selectedVersion && (
            <div className="version-actions">
              <div className="version-meta"><span>Trạng thái</span><strong>{outlineStatusLabel(selectedVersion)}</strong>{selectedVersion.originVersion && <small>Khôi phục từ phiên bản {selectedVersion.originVersion}</small>}</div>
              <button className="button button--primary" disabled={busy || selectedVersion.status === 'approved'} onClick={() => {
                if (window.confirm(`Duyệt dàn ý phiên bản ${selectedVersion.version} làm nguồn viết?`)) void mutate('outline:approve', { versionId: selectedVersion.id }, `Đã duyệt dàn ý phiên bản ${selectedVersion.version}.`)
              }}><Check size={15} /> {selectedVersion.status === 'approved' ? 'Đã duyệt' : 'Duyệt phiên bản'}</button>
              <button className="button button--secondary" disabled={busy} onClick={() => {
                if (window.confirm(`Tạo một phiên bản mới từ phiên bản ${selectedVersion.version}? Phiên bản gốc sẽ được giữ nguyên.`)) void mutate('outline:restore', { versionId: selectedVersion.id }, `Đã khôi phục phiên bản ${selectedVersion.version} thành bản mới.`)
              }}><RotateCcw size={15} /> Khôi phục thành bản mới</button>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function CanonStudio({ snapshot }: { snapshot: BootstrapSnapshot }): ReactNode {
  const groups = useMemo(() => Object.groupBy(snapshot.canon, (fact) => fact.category), [snapshot.canon])
  const memoryTokens = snapshot.chapterSummaries.reduce((total, summary) => total + summary.tokenEstimate, 0)
  const openThreads = snapshot.chapterSummaries.reduce((total, summary) => total + summary.unresolvedThreads.length, 0)
  return (
    <div className="studio-page">
      <section className="page-lead">
        <div><span className="eyebrow">STORY MEMORY · CÓ NGUỒN</span><h2>Ký ức dài hạn của truyện</h2><p>Canon và tóm tắt chương được truy xuất theo độ liên quan, sau đó cắt đúng ngân sách context trước khi gửi tới AI.</p></div>
        <button className="button button--secondary" disabled title="Quản lý canon thủ công sẽ có trong sprint sau"><Plus size={15} /> Thêm dữ kiện</button>
      </section>
      <section className="memory-health" aria-label="Tình trạng bộ nhớ truyện">
        <div><BookOpenText size={16} /><span><strong>{snapshot.chapterSummaries.length}</strong><small>Tóm tắt chương</small></span></div>
        <div><BrainCircuit size={16} /><span><strong>{memoryTokens.toLocaleString('vi-VN')}</strong><small>Token ước tính đã index</small></span></div>
        <div><Clock3 size={16} /><span><strong>{openThreads}</strong><small>Tuyến chưa khép</small></span></div>
        <div><LibraryBig size={16} /><span><strong>{snapshot.canon.length}</strong><small>Dữ kiện canon</small></span></div>
      </section>
      <section className="chapter-memory">
        <div className="settings-section__head"><div><h3>Ký ức theo chương</h3><p>Mỗi tóm tắt gắn với document version nguồn và được làm mới sau autosave hoặc approval.</p></div><span className="chip">PROVENANCE BẮT BUỘC</span></div>
        <div className="chapter-memory__grid">
          {snapshot.chapterSummaries.slice(0, 12).map((summary) => (
            <article className="chapter-memory-card" key={summary.id}>
              <div><span>CHƯƠNG {String(summary.chapterNumber).padStart(2, '0')}</span><small>Document V{summary.sourceVersion}</small></div>
              <h3>{summary.chapterTitle}</h3>
              <p>{summary.summary}</p>
              <div className="memory-tags">{summary.characters.slice(0, 2).map((item) => <span key={item}>{item}</span>)}{summary.locations.slice(0, 1).map((item) => <span key={item}>{item}</span>)}</div>
              <small>{summary.tokenEstimate.toLocaleString('vi-VN')} token · {summary.unresolvedThreads.length} tuyến mở</small>
            </article>
          ))}
          {snapshot.chapterSummaries.length === 0 && <div className="artifact-empty">Tóm tắt sẽ được tạo tự động khi chương được lưu.</div>}
        </div>
      </section>
      <div className="memory-section-title"><div><span className="panel-kicker">CANON RETRIEVAL</span><h3>Sự thật của thế giới truyện</h3></div><small>Chỉ dữ kiện có provenance mới được đưa vào context.</small></div>
      <div className="canon-grid">
        {Object.entries(groups).map(([category, facts]) => (
          <section className="canon-group" key={category}>
            <div className="canon-group__head"><span className={`canon-icon canon-icon--${category}`}>{canonIcon(category)}</span><div><h3>{canonLabel(category)}</h3><p>{facts?.length ?? 0} dữ kiện</p></div><ChevronRight size={15} /></div>
            {facts?.map((fact) => (
              <article className="fact-card" key={fact.id}>
                <div><strong>{fact.subject}</strong><span className="confidence"><i style={{ width: `${fact.confidence * 100}%` }} /></span></div>
                <p>{fact.fact}</p>
                <small>{fact.sourceChapter ? `Nguồn · Chương ${fact.sourceChapter}` : 'Nguồn · Định hướng tác giả'}</small>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

function AgentStudio({ snapshot, selectedChapter, onSnapshot, onToast, onOpenWorkflow }: {
  snapshot: BootstrapSnapshot
  selectedChapter?: Chapter
  onSnapshot: (value: BootstrapSnapshot) => void
  onToast: (message: string, tone?: Toast['tone']) => void
  onOpenWorkflow: () => void
}): ReactNode {
  const [preset, setPreset] = useState<WorkflowPreset>('balanced')
  const [busy, setBusy] = useState(false)
  const [routes, setRoutes] = useState<ProviderRoute[]>([])
  const hasApprovedOutline = snapshot.outlineVersions.some((version) => version.status === 'approved')
  const activeRun = snapshot.workflowRuns.find((run) => run.chapterId === selectedChapter?.id && ['queued', 'running', 'paused', 'waiting_review', 'interrupted', 'billing_unknown'].includes(run.status))
  const workflowSteps = getWorkflowSteps(preset)

  useEffect(() => {
    let active = true
    void window.novelAgent.vault.routing().then((value) => { if (active) setRoutes(value) })
    return () => { active = false }
  }, [])

  const start = async (): Promise<void> => {
    if (!selectedChapter || busy) return
    setBusy(true)
    try {
      const updated = await window.novelAgent.invoke<BootstrapSnapshot>('workflow:start', { chapterId: selectedChapter.id, preset })
      onSnapshot(updated)
      onOpenWorkflow()
      onToast(`Đã bắt đầu workflow cho chương ${selectedChapter.number}.`, 'success')
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'Không thể bắt đầu workflow.', 'danger')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="studio-page">
      <section className="page-lead">
        <div><span className="eyebrow">WORKFLOW · {presetLabel(preset).toLocaleUpperCase('vi')}</span><h2>Phòng biên tập tám vai trò</h2><p>Mỗi vai tạo một artifact có schema và checkpoint riêng. Chỉ Nhà văn tạo prose; chương và canon chỉ được commit sau khi bạn duyệt.</p></div>
        <div className="workflow-launch">
          <div className="segmented" aria-label="Chọn preset workflow">{(['fast', 'balanced', 'quality'] as const).map((item) => <button key={item} data-active={preset === item} onClick={() => setPreset(item)}>{presetLabel(item)}</button>)}</div>
          {activeRun
            ? <button className="button button--primary" onClick={onOpenWorkflow}><BrainCircuit size={15} /> Xem workflow {Math.round(activeRun.progress)}%</button>
            : <button className="button button--primary" disabled={busy || !selectedChapter || !hasApprovedOutline} title={!hasApprovedOutline ? 'Hãy duyệt dàn ý trước khi chạy workflow' : undefined} onClick={() => void start()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />} Chạy {selectedChapter ? `chương ${selectedChapter.number}` : 'workflow'}</button>}
        </div>
      </section>
      <div className="agent-grid">
        {snapshot.roles.map((role, index) => <AgentCard role={role} route={routes.find((item) => item.roleId === role.id)} index={index} key={role.id} />)}
      </div>
      <section className="pipeline-panel">
        <div className="pipeline-panel__head"><div><span className="panel-kicker">PIPELINE MỘT CHƯƠNG · {workflowSteps.length} CHECKPOINT</span><h3>{selectedChapter ? `Chương ${selectedChapter.number} · ${selectedChapter.title}` : 'Chọn một chương để bắt đầu'}</h3></div><span className="chip chip--good"><ShieldCheck size={13} /> Không ghi đè</span></div>
        <div className="pipeline">
          {workflowSteps.map((step, index, items) => (
            <div className="pipeline-step" key={`${step.kind}-${index}`}><span>{index + 1}</span><strong>{step.label}</strong>{index < items.length - 1 && <ChevronRight size={14} />}</div>
          ))}
        </div>
      </section>
    </div>
  )
}

function AgentCard({ role, route, index }: { role: RoleProfile; route?: ProviderRoute; index: number }): ReactNode {
  return (
    <article className="agent-card" style={{ '--agent-color': role.color, '--delay': `${index * 32}ms` } as React.CSSProperties}>
      <div className="agent-card__head"><div className="agent-avatar"><Bot size={18} /></div><span className={`agent-state agent-state--${role.state}`}>{role.state === 'ready' ? 'Sẵn sàng' : role.state === 'working' ? 'Đang làm' : role.state === 'blocked' ? 'Bị chặn' : 'Đang chờ'}</span></div>
      <h3>{role.name}</h3><p>{role.description}</p>
      <div className="agent-model"><span>{route?.provider === 'demo' || !route ? 'DEMO' : providerLabel(route.provider)}</span><strong>{route?.model ?? role.model}</strong><ChevronDown size={13} /></div>
    </article>
  )
}

function VisualStudio(): ReactNode {
  const cards = [
    { label: 'BÌA SÁCH', title: 'Thành phố không tên', ratio: '2 / 3', tone: 'amber' },
    { label: 'NHÂN VẬT', title: 'An · Thủ thư ký ức', ratio: '4 / 5', tone: 'violet' },
    { label: 'BỐI CẢNH', title: 'Tháp chuông Lam Kính', ratio: '16 / 9', tone: 'blue' }
  ]
  return (
    <div className="studio-page">
      <section className="page-lead">
        <div><span className="eyebrow">VISUAL BIBLE · CHƯA KHÓA</span><h2>Một ngôn ngữ hình ảnh nhất quán</h2><p>Giám đốc hình ảnh chỉ chuẩn bị đề xuất. Provider sẽ không phát sinh chi phí trước khi bạn duyệt.</p></div>
        <button className="button button--primary" disabled title="Visual generation sẽ có trong sprint sau"><WandSparkles size={15} /> Tạo đề xuất</button>
      </section>
      <section className="visual-bible">
        <div className="visual-bible__copy"><span className="panel-kicker">ART DIRECTION</span><h3>Thủy tinh ký ức</h3><p>Editorial fantasy, ánh sáng hổ phách xuyên qua kính xanh đêm. Chất liệu vẽ gouache kết hợp nét khắc đồng mảnh.</p><div className="palette"><span style={{ background: '#171a22' }} /><span style={{ background: '#29435c' }} /><span style={{ background: '#c18a49' }} /><span style={{ background: '#e0c79c' }} /><span style={{ background: '#8f6b95' }} /></div></div>
        <div className="visual-bible__rules"><span>PHẢI CÓ</span><p>Ánh sáng có cấu trúc · Khoảng tối sâu · Con người nhỏ trước kiến trúc</p><span>TRÁNH</span><p>Cyberpunk · Neon bão hòa · Typography nằm trong ảnh AI</p></div>
      </section>
      <div className="visual-grid">
        {cards.map((card) => (
          <article className={`visual-card visual-card--${card.tone}`} key={card.title}>
            <div className="visual-card__canvas"><div className="visual-placeholder"><Sparkles size={24} /><span>Đề xuất đang chờ duyệt</span></div></div>
            <div className="visual-card__footer"><div><span>{card.label}</span><h3>{card.title}</h3><p>Tỷ lệ {card.ratio} · 2 biến thể</p></div><button className="button button--secondary" disabled title="Prompt hình ảnh sẽ có trong sprint sau">Xem prompt</button></div>
          </article>
        ))}
      </div>
    </div>
  )
}

function SettingsStudio({ snapshot, onToast }: { snapshot: BootstrapSnapshot; onToast: (message: string, tone?: Toast['tone']) => void }): ReactNode {
  const [connections, setConnections] = useState<ProviderConnection[]>([])
  const [preferred, setPreferred] = useState<Exclude<ProviderKind, 'demo'> | null>(null)
  const [routes, setRoutes] = useState<ProviderRoute[]>([])
  const [editing, setEditing] = useState<Exclude<ProviderKind, 'demo'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [dataBusy, setDataBusy] = useState<string | null>(null)
  const [dataStatus, setDataStatus] = useState<RecoveryStatus | null>(null)
  const [health, setHealth] = useState<Partial<Record<Exclude<ProviderKind, 'demo'>, { ok: boolean; latencyMs: number; message: string }>>>({})

  const refresh = useCallback(async () => {
    const [nextConnections, nextPreferred, nextRoutes, nextDataStatus] = await Promise.all([
      window.novelAgent.vault.list(),
      window.novelAgent.vault.preferred(),
      window.novelAgent.vault.routing(),
      window.novelAgent.recovery.status()
    ])
    setConnections(nextConnections)
    setPreferred(nextPreferred)
    setRoutes(nextRoutes)
    setDataStatus(nextDataStatus)
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const runDataAction = async (action: 'backup' | 'restore' | 'export' | 'import'): Promise<void> => {
    setDataBusy(action)
    try {
      if (action === 'backup') {
        const result = await window.novelAgent.backup()
        if (result) onToast(`Backup đạt integrity · schema v${result.inspection.schemaVersion}`, 'success')
      } else if (action === 'export') {
        const result = await window.novelAgent.projectArchive.export()
        if (result) onToast(`Đã xuất project archive · ${result.bookCount} sách · không chứa API key`, 'success')
      } else {
        const result = action === 'restore'
          ? await window.novelAgent.restoreBackup()
          : await window.novelAgent.projectArchive.import()
        if (result) onToast('Đã khôi phục an toàn. Ứng dụng đang khởi động lại…', 'success')
      }
      await refresh()
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'Không thể hoàn tất thao tác dữ liệu.', 'danger')
    } finally {
      setDataBusy(null)
    }
  }

  return (
    <div className="studio-page settings-page">
      <section className="page-lead">
        <div><span className="eyebrow">LOCAL-FIRST · BYOK</span><h2>Kết nối model của bạn</h2><p>API key được mã hóa bằng Windows DPAPI và không bao giờ đi qua renderer sau khi lưu.</p></div>
        <span className="chip chip--good"><ShieldCheck size={13} /> Vault được bảo vệ</span>
      </section>
      <section className="settings-section">
        <div className="settings-section__head"><div><h3>Provider văn bản</h3><p>Mỗi vai trò có thể dùng model riêng sau khi provider được kết nối.</p></div></div>
        <div className="provider-grid">
          {(['openai', 'anthropic', 'gemini', 'ollama'] as const).map((kind) => {
            const connection = connections.find((item) => item.kind === kind)
            const currentHealth = health[kind]
            return (
              <article className="provider-card" key={kind}>
                <div className={`provider-logo provider-logo--${kind}`}>{providerInitial(kind)}</div>
                <div className="provider-card__copy"><h4>{providerName(kind)}</h4><p>{connection ? `${connection.model} · ${connection.maskedKey}` : providerDescription(kind)}</p></div>
                <span className={`provider-status ${currentHealth?.ok ? 'provider-status--good' : connection ? 'provider-status--configured' : ''}`}><span />{currentHealth ? currentHealth.ok ? `Sẵn sàng · ${currentHealth.latencyMs} ms` : 'Không phản hồi' : preferred === kind ? 'Đạo diễn · chưa kiểm tra' : connection ? 'Đã cấu hình · chưa kiểm tra' : kind === 'ollama' ? 'Chưa phát hiện' : 'Chưa cấu hình'}</span>
                <button className="button button--secondary" onClick={() => setEditing(kind)}>{connection ? 'Chỉnh sửa' : 'Kết nối'}</button>
                {connection && <div className="provider-card__actions">
                  {preferred !== kind && <button className="text-button" disabled={busy} onClick={async () => { setBusy(true); await window.novelAgent.vault.setPreferred(kind); await refresh(); setBusy(false); onToast(`Đạo diễn sẽ dùng ${providerName(kind)}.`, 'success') }}>Dùng cho Đạo diễn</button>}
                  <button className="text-button" disabled={busy} onClick={async () => { setBusy(true); try { const result = await window.novelAgent.vault.test(kind); setHealth((current) => ({ ...current, [kind]: result })); onToast(`${providerName(kind)}: ${result.message} · ${result.latencyMs} ms`, result.ok ? 'success' : 'danger') } catch (cause) { onToast(cause instanceof Error ? cause.message : 'Không thể kiểm tra provider.', 'danger') } finally { setBusy(false) } }}>Kiểm tra</button>
                  <button className="text-button text-button--danger" disabled={busy} onClick={async () => { if (!window.confirm(`Xóa kết nối ${providerName(kind)} khỏi máy này?`)) return; setBusy(true); await window.novelAgent.vault.remove(kind); await refresh(); setBusy(false); onToast(`Đã xóa kết nối ${providerName(kind)}.`, 'success') }}>Xóa</button>
                </div>}
              </article>
            )
          })}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section__head"><div><h3>Routing theo vai trò</h3><p>Provider và model được khóa vào từng checkpoint khi workflow bắt đầu. Đổi routing chỉ áp dụng cho workflow mới.</p></div><span className="chip">Tối đa 2 request / provider</span></div>
        <div className="role-routing">
          {snapshot.roles.map((role) => {
            const route = routes.find((item) => item.roleId === role.id) ?? {
              roleId: role.id,
              provider: 'demo' as const,
              model: 'deterministic-v1',
              inputCostPerMillion: null,
              outputCostPerMillion: null,
              contextTokenBudget: 16_000
            }
            const patchRoute = (patch: Partial<ProviderRoute>): void => {
              setRoutes((current) => current.some((item) => item.roleId === role.id)
                ? current.map((item) => item.roleId === role.id ? { ...item, ...patch } : item)
                : [...current, { ...route, ...patch }])
            }
            return (
              <article className="role-route" key={role.id}>
                <div className="role-route__identity"><span className="agent-avatar"><Bot size={16} /></span><div><strong>{role.shortName}</strong><small>{role.description}</small></div></div>
                <label><span>Provider</span><select value={route.provider} onChange={(event) => {
                  const provider = event.target.value as ProviderKind
                  const connection = provider === 'demo' ? null : connections.find((item) => item.kind === provider)
                  patchRoute({
                    provider,
                    model: connection?.model ?? 'deterministic-v1',
                    inputCostPerMillion: null,
                    outputCostPerMillion: null
                  })
                }}><option value="demo">Demo cục bộ</option>{connections.map((connection) => <option value={connection.kind} key={connection.kind}>{providerName(connection.kind)}</option>)}</select></label>
                <label><span>Model</span><input value={route.model} disabled={route.provider === 'demo'} onChange={(event) => patchRoute({ model: event.target.value })} /></label>
                <label><span>Context tối đa</span><input type="number" min="2000" max="1000000" step="1000" value={route.contextTokenBudget} onChange={(event) => patchRoute({ contextTokenBudget: Math.max(2_000, Number(event.target.value) || 2_000) })} /></label>
                <label><span>USD / 1M token vào</span><input type="number" min="0" step="0.01" value={route.inputCostPerMillion ?? ''} disabled={route.provider === 'demo' || route.provider === 'ollama'} placeholder="Chưa đặt" onChange={(event) => patchRoute({ inputCostPerMillion: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                <label><span>USD / 1M token ra</span><input type="number" min="0" step="0.01" value={route.outputCostPerMillion ?? ''} disabled={route.provider === 'demo' || route.provider === 'ollama'} placeholder="Chưa đặt" onChange={(event) => patchRoute({ outputCostPerMillion: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                <button className="button button--secondary" disabled={busy || !route.model.trim()} onClick={async () => {
                  setBusy(true)
                  try {
                    await window.novelAgent.vault.setRoute(route)
                    await refresh()
                    onToast(`Đã lưu routing cho ${role.shortName}.`, 'success')
                  } catch (cause) {
                    onToast(cause instanceof Error ? cause.message : 'Không thể lưu routing.', 'danger')
                  } finally {
                    setBusy(false)
                  }
                }}><Save size={14} /> Lưu</button>
              </article>
            )
          })}
        </div>
        <p className="settings-note"><ShieldCheck size={14} /> Context được xếp hạng và cắt đúng ngân sách trước khi gửi. Usage lấy từ phản hồi provider; chi phí chỉ được ước tính khi bạn nhập đủ đơn giá.</p>
      </section>
      <section className="settings-section data-safety">
        <div className="settings-section__head"><div><h3>Data Safety & Recovery</h3><p>Mọi nguồn restore đều được kiểm tra trước; workspace hiện tại luôn có recovery point trước khi bị thay thế.</p></div><span className="chip chip--good"><ShieldCheck size={13} /> SQLite an toàn</span></div>
        <div className="data-health-grid">
          <div><DatabaseBackup size={16} /><span><small>Schema ứng dụng</small><strong>v{snapshot.database.schemaVersion}</strong></span></div>
          <div><ShieldCheck size={16} /><span><small>Integrity gần nhất</small><strong>{dataStatus?.safeMode ? 'Cần phục hồi' : 'OK'}</strong></span></div>
          <div><Archive size={16} /><span><small>Recovery points</small><strong>{dataStatus?.recoveryPoints.length ?? 0}</strong></span></div>
          <div><FileArchive size={16} /><span><small>Project archive</small><strong>Không chứa secret</strong></span></div>
        </div>
        <div className="data-actions">
          <button className="data-action" disabled={Boolean(dataBusy)} onClick={() => void runDataAction('backup')}><span><DatabaseBackup size={18} /></span><div><strong>Sao lưu SQLite</strong><small>Snapshot toàn vẹn để khôi phục tại chỗ</small></div>{dataBusy === 'backup' ? <LoaderCircle size={15} className="spin" /> : <ChevronRight size={15} />}</button>
          <button className="data-action" disabled={Boolean(dataBusy)} onClick={() => void runDataAction('export')}><span><FileArchive size={18} /></span><div><strong>Xuất project archive</strong><small>Gói `.novelproj` có manifest và SHA-256</small></div>{dataBusy === 'export' ? <LoaderCircle size={15} className="spin" /> : <ChevronRight size={15} />}</button>
          <button className="data-action data-action--warning" disabled={Boolean(dataBusy)} onClick={() => void runDataAction('restore')}><span><RotateCcw size={18} /></span><div><strong>Khôi phục từ backup</strong><small>Thay workspace sau khi tạo điểm quay lui</small></div>{dataBusy === 'restore' ? <LoaderCircle size={15} className="spin" /> : <ChevronRight size={15} />}</button>
          <button className="data-action data-action--warning" disabled={Boolean(dataBusy)} onClick={() => void runDataAction('import')}><span><Upload size={18} /></span><div><strong>Nhập project archive</strong><small>Kiểm tra checksum trước khi mở dữ liệu</small></div>{dataBusy === 'import' ? <LoaderCircle size={15} className="spin" /> : <ChevronRight size={15} />}</button>
        </div>
        {(dataStatus?.recoveryPoints.length ?? 0) > 0 && <div className="recovery-points"><div><span>RECOVERY POINT GẦN NHẤT</span><small>Được tạo tự động trước migration hoặc restore</small></div>{dataStatus?.recoveryPoints.slice(0, 3).map((point) => <div className="recovery-point" key={point.path}><span data-integrity={point.integrity} /><div><strong>{point.kind === 'migration' ? 'Trước migration' : 'Trước restore'}</strong><small>{new Date(point.createdAt).toLocaleString('vi-VN')} · {formatBytes(point.sizeBytes)} · {point.schemaVersion ? `schema v${point.schemaVersion}` : 'không đọc được schema'}</small></div></div>)}</div>}
      </section>
      <section className="settings-section two-column-settings">
        <div className="setting-card"><div className="setting-card__icon"><Wifi size={18} /></div><div><h3>Nghiên cứu web</h3><p>Provider-native + Brave Search fallback</p><small>Fact từ web luôn cần nguồn trước khi vào canon.</small></div><span className="chip">Chưa cấu hình Brave</span></div>
        <div className="setting-card"><div className="setting-card__icon"><ShieldCheck size={18} /></div><div><h3>Runtime cô lập</h3><p>Renderer sandbox · utility process</p><small>Restore chỉ chạy sau khi utility process đã đóng SQLite.</small></div><span className="chip chip--good">Đã bật</span></div>
      </section>
      {editing && <ProviderDialog kind={editing} existing={connections.find((item) => item.kind === editing)} onClose={() => setEditing(null)} onSaved={async () => { await refresh(); setEditing(null); onToast('Đã mã hóa và lưu kết nối.', 'success') }} />}
    </div>
  )
}

function WorkflowCenterDialog({ snapshot, onClose, onSnapshot, onToast }: {
  snapshot: BootstrapSnapshot
  onClose: () => void
  onSnapshot: (value: BootstrapSnapshot) => void
  onToast: (message: string, tone?: Toast['tone']) => void
}): ReactNode {
  const [selectedRunId, setSelectedRunId] = useState(snapshot.workflowRuns[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const selectedRun = snapshot.workflowRuns.find((run) => run.id === selectedRunId) ?? snapshot.workflowRuns[0]

  useEffect(() => {
    if (!snapshot.workflowRuns.some((run) => run.id === selectedRunId)) setSelectedRunId(snapshot.workflowRuns[0]?.id ?? '')
  }, [selectedRunId, snapshot.workflowRuns])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  const mutate = async (channel: string, payload: unknown, message: string): Promise<void> => {
    setBusy(true)
    try {
      const updated = await window.novelAgent.invoke<BootstrapSnapshot>(channel, payload)
      onSnapshot(updated)
      onToast(message, 'success')
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'Không thể cập nhật workflow.', 'danger')
    } finally {
      setBusy(false)
    }
  }

  const chapter = selectedRun ? snapshot.chapters.find((item) => item.id === selectedRun.chapterId) : undefined
  const proposedDraft = selectedRun ? [...selectedRun.artifacts].reverse().find((artifact) => artifact.kind === 'revised_draft')
    ?? [...selectedRun.artifacts].reverse().find((artifact) => artifact.kind === 'draft') : undefined

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="dialog dialog--workflow" role="dialog" aria-modal="true" aria-labelledby="workflow-center-title">
        <div className="dialog__head"><div><span className="eyebrow">DURABLE AI WORKFLOW</span><h2 id="workflow-center-title">Hàng đợi & Review Center</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={17} /></button></div>
        {snapshot.workflowRuns.length === 0 ? (
          <div className="manager-empty"><BrainCircuit size={26} /><h3>Chưa có workflow</h3><p>Chọn một chương trong AI Studio, duyệt dàn ý rồi bắt đầu pipeline đầu tiên.</p></div>
        ) : (
          <div className="workflow-center">
            <aside className="workflow-run-list">
              <div className="manager-heading"><span>LỊCH SỬ CHẠY</span><span>{snapshot.workflowRuns.length}</span></div>
              {snapshot.workflowRuns.map((run) => (
                <button className="workflow-run-row" data-active={run.id === selectedRun?.id} onClick={() => setSelectedRunId(run.id)} key={run.id}>
                  <span className={`workflow-status-dot workflow-status-dot--${run.status}`} />
                  <span><strong>Chương {run.chapterNumber}</strong><small>{workflowStatusLabel(run.status)} · {presetLabel(run.preset)}</small></span>
                  <strong>{Math.round(run.progress)}%</strong>
                </button>
              ))}
            </aside>
            {selectedRun && (
              <section className="workflow-detail">
                <div className="workflow-detail__head">
                  <div><span className="panel-kicker">CHƯƠNG {String(selectedRun.chapterNumber).padStart(2, '0')} · {presetLabel(selectedRun.preset).toLocaleUpperCase('vi')}</span><h3>{selectedRun.chapterTitle}</h3><p>{selectedRun.detail}</p></div>
                  <span className={`workflow-status workflow-status--${selectedRun.status}`}>{workflowStatusLabel(selectedRun.status)}</span>
                </div>
                <div className="workflow-metrics">
                  <div><span>Tiến độ</span><strong>{Math.round(selectedRun.progress)}%</strong></div>
                  <div><span>Token vào</span><strong>{selectedRun.inputTokens.toLocaleString('vi-VN')}</strong></div>
                  <div><span>Token ra</span><strong>{selectedRun.outputTokens.toLocaleString('vi-VN')}</strong></div>
                  <div><span>Chi phí</span><strong>{formatEstimatedCost(selectedRun.estimatedCost, selectedRun.costStatus)}</strong></div>
                </div>
                {selectedRun.status === 'billing_unknown' && <div className="billing-warning" role="alert"><CircleAlert size={18} /><div><strong>Chưa xác định request có phát sinh phí</strong><p>Ứng dụng đã dừng để tránh gọi provider khác hoặc tạo request trùng. Kiểm tra dashboard provider trước khi thử lại thủ công.</p></div></div>}
                <div className="workflow-progress"><span style={{ width: `${selectedRun.progress}%` }} /></div>
                <div className="workflow-controls">
                  {(selectedRun.status === 'queued' || selectedRun.status === 'running') && <button className="button button--secondary" disabled={busy} onClick={() => void mutate('workflow:pause', { runId: selectedRun.id }, 'Đã tạm dừng workflow.') }><Pause size={14} /> Tạm dừng</button>}
                  {(selectedRun.status === 'paused' || selectedRun.status === 'interrupted') && <button className="button button--primary" disabled={busy} onClick={() => void mutate('workflow:resume', { runId: selectedRun.id }, 'Workflow đang tiếp tục từ checkpoint.') }><Play size={14} /> Tiếp tục</button>}
                  {selectedRun.status === 'failed' && selectedRun.error !== 'review_rejected' && <button className="button button--primary" disabled={busy} onClick={() => void mutate('workflow:retry', { runId: selectedRun.id }, 'Workflow đang thử lại bước lỗi.') }><RotateCcw size={14} /> Thử lại</button>}
                  {selectedRun.status === 'billing_unknown' && <button className="button button--primary" disabled={busy} onClick={() => { if (window.confirm('Request trước có thể đã phát sinh phí. Bạn đã kiểm tra dashboard provider và vẫn muốn tạo attempt mới?')) void mutate('workflow:retry', { runId: selectedRun.id }, 'Đã tạo attempt mới sau xác nhận của bạn.') }}><RotateCcw size={14} /> Đã kiểm tra · thử lại</button>}
                  {['queued', 'running', 'paused', 'interrupted', 'billing_unknown'].includes(selectedRun.status) && <button className="button button--danger-outline" disabled={busy} onClick={() => { if (window.confirm('Hủy workflow này? Các artifact đã tạo vẫn được giữ để audit nhưng sẽ không được commit.')) void mutate('workflow:cancel', { runId: selectedRun.id }, 'Đã hủy workflow.') }}><Square size={13} /> Hủy</button>}
                </div>
                <div className="workflow-columns">
                  <div className="workflow-steps">
                    <div className="manager-heading"><span>CHECKPOINT</span><span>{selectedRun.steps.filter((step) => step.status === 'completed').length}/{selectedRun.steps.length}</span></div>
                    {selectedRun.steps.map((step) => (
                      <div className="workflow-step-row" data-status={step.status} key={step.id}>
                        <span className="workflow-step-index">{step.ordinal + 1}</span>
                        <span><strong>{step.label}</strong><small>{roleName(snapshot, step.roleId)} · {providerLabel(step.provider)} / {step.model} · {(step.contextTokenBudget / 1_000).toLocaleString('vi-VN')}k ctx · {step.promptVersion}</small>{(step.retryCount > 0 || step.httpStatus || step.billingState === 'unknown') && <small className="workflow-step-meta">{step.httpStatus ? `HTTP ${step.httpStatus} · ` : ''}{step.retryCount > 0 ? `${step.retryCount} lần retry · ` : ''}{step.billingState === 'unknown' ? 'billing chưa xác định' : `request ${step.requestId?.slice(0, 8) ?? '—'}`}</small>}</span>
                        <span>{step.status === 'completed' ? <Check size={14} /> : step.status === 'running' ? <LoaderCircle size={14} className="spin" /> : step.status === 'failed' || step.status === 'billing_unknown' ? <CircleAlert size={14} /> : <span className="status-dot" />}</span>
                      </div>
                    ))}
                  </div>
                  <div className="workflow-artifacts">
                    <div className="manager-heading"><span>ARTIFACT</span><span>{selectedRun.artifacts.length}</span></div>
                    {selectedRun.artifacts.map((artifact) => <ArtifactCard artifact={artifact} snapshot={snapshot} key={artifact.id} />)}
                    {selectedRun.artifacts.length === 0 && <div className="artifact-empty">Artifact sẽ xuất hiện sau mỗi checkpoint.</div>}
                  </div>
                </div>
                {selectedRun.status === 'waiting_review' && proposedDraft && (
                  <div className="review-gate">
                    <div className="review-gate__head"><div><span className="panel-kicker">APPROVAL GATE</span><h3>So sánh trước khi commit</h3><p>Duyệt sẽ tạo document version mới và commit canon delta. Bản hiện tại không bị ghi đè trong lịch sử.</p></div><ShieldCheck size={20} /></div>
                    <div className="review-comparison">
                      <div><span>BẢN HIỆN TẠI</span><p>{chapter ? extractDocumentText(chapter.content) || 'Chương chưa có nội dung.' : 'Không tìm thấy chương.'}</p></div>
                      <div><span>BẢN AI ĐỀ XUẤT</span><p>{extractArtifactDocumentText(proposedDraft)}</p></div>
                    </div>
                    <div className="review-actions"><button className="button button--danger-outline" disabled={busy} onClick={() => { if (window.confirm('Từ chối toàn bộ đề xuất của workflow này? Artifact vẫn được giữ trong lịch sử.')) void mutate('workflow:review', { runId: selectedRun.id, decision: 'reject' }, 'Đã từ chối đề xuất; dữ liệu chương không thay đổi.') }}>Từ chối</button><button className="button button--primary" disabled={busy} onClick={() => { if (window.confirm('Duyệt bản sửa và canon delta để commit thành phiên bản chương mới?')) void mutate('workflow:review', { runId: selectedRun.id, decision: 'approve' }, 'Đã duyệt và commit phiên bản chương mới.') }}><Check size={15} /> Duyệt & commit</button></div>
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ArtifactCard({ artifact, snapshot }: { artifact: WorkflowArtifact; snapshot: BootstrapSnapshot }): ReactNode {
  const preview = artifact.kind === 'draft' || artifact.kind === 'revised_draft' ? extractArtifactDocumentText(artifact) : artifact.summary
  const contextBudget = artifact.kind === 'context_packet' && artifact.data.budget && typeof artifact.data.budget === 'object'
    ? artifact.data.budget as { used?: number; limit?: number; omittedSources?: number; truncatedSources?: number }
    : null
  const continuityIssues = artifact.kind === 'context_packet' && Array.isArray(artifact.data.continuityIssues)
    ? artifact.data.continuityIssues as Array<{ severity?: string; message?: string }>
    : []
  return (
    <details className="artifact-card">
      <summary><span className={`artifact-kind artifact-kind--${artifact.status}`}>{artifactKindLabel(artifact.kind)}</span><span><strong>{artifact.title}</strong><small>{roleName(snapshot, artifact.roleId)} · {artifactStatusLabel(artifact.status)}</small></span><ChevronRight size={14} /></summary>
      <p>{preview}</p>
      {contextBudget && <div className="context-budget"><span><strong>{Number(contextBudget.used ?? 0).toLocaleString('vi-VN')}</strong> / {Number(contextBudget.limit ?? 0).toLocaleString('vi-VN')} token</span><span>{contextBudget.omittedSources ?? 0} nguồn bỏ qua · {contextBudget.truncatedSources ?? 0} rút gọn</span></div>}
      {continuityIssues.length > 0 && <div className="continuity-list">{continuityIssues.slice(0, 4).map((issue, index) => <span data-severity={issue.severity} key={`${issue.message}-${index}`}><CircleAlert size={12} />{issue.message}</span>)}</div>}
    </details>
  )
}

type ProjectEditor =
  | { kind: 'series'; value?: Series }
  | { kind: 'book'; seriesId: string; value?: Book }

function ProjectManagerDialog({ snapshot, onClose, onSnapshot, onToast }: {
  snapshot: BootstrapSnapshot
  onClose: () => void
  onSnapshot: (value: BootstrapSnapshot) => void
  onToast: (message: string, tone?: Toast['tone']) => void
}): ReactNode {
  const [selectedSeriesId, setSelectedSeriesId] = useState(snapshot.activeBook.seriesId)
  const [editor, setEditor] = useState<ProjectEditor | null>(null)
  const [busy, setBusy] = useState(false)
  const selectedSeries = snapshot.series.find((series) => series.id === selectedSeriesId) ?? snapshot.series[0]
  const books = snapshot.books.filter((book) => book.seriesId === selectedSeries?.id)

  useEffect(() => {
    if (!snapshot.series.some((series) => series.id === selectedSeriesId)) {
      setSelectedSeriesId(snapshot.activeBook.seriesId)
    }
  }, [selectedSeriesId, snapshot.activeBook.seriesId, snapshot.series])

  const mutate = async (channel: string, payload: unknown, message: string): Promise<BootstrapSnapshot | null> => {
    setBusy(true)
    try {
      const updated = await window.novelAgent.invoke<BootstrapSnapshot>(channel, payload)
      onSnapshot(updated)
      onToast(message, 'success')
      return updated
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'Không thể cập nhật dự án.', 'danger')
      return null
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="project-manager-title">
        <div className="dialog__head"><div><span className="eyebrow">THƯ VIỆN SÁNG TÁC</span><h2 id="project-manager-title">Series & sách</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={17} /></button></div>
        <div className="project-manager">
          <section className="project-manager__series">
            <div className="manager-heading"><span>SERIES</span><button className="icon-button" disabled={busy} onClick={() => setEditor({ kind: 'series' })} aria-label="Tạo series"><FolderPlus size={15} /></button></div>
            <div className="manager-list">
              {snapshot.series.map((series) => (
                <button className="manager-series-row" data-active={series.id === selectedSeries?.id} onClick={() => { setSelectedSeriesId(series.id); setEditor(null) }} key={series.id}>
                  <span className="manager-monogram">{initials(series.name)}</span><span><strong>{series.name}</strong><small>{series.bookCount} sách</small></span><ChevronRight size={14} />
                </button>
              ))}
            </div>
          </section>
          <section className="project-manager__books">
            {selectedSeries && (
              <>
                <div className="manager-series-head">
                  <div><span className="panel-kicker">SERIES ĐANG CHỌN</span><h3>{selectedSeries.name}</h3><p>{selectedSeries.description || 'Chưa có mô tả.'}</p></div>
                  <div className="manager-actions">
                    <button className="icon-button icon-button--bordered" disabled={busy} onClick={() => setEditor({ kind: 'series', value: selectedSeries })} aria-label="Sửa series" title="Sửa series"><Edit3 size={15} /></button>
                    <button className="icon-button icon-button--bordered danger-action" disabled={busy} onClick={() => {
                      if (window.confirm(`Lưu trữ series “${selectedSeries.name}” cùng các sách và chương bên trong? Dữ liệu vẫn được giữ trong database.`)) {
                        void mutate('workspace:archive-series', { id: selectedSeries.id }, `Đã lưu trữ series “${selectedSeries.name}”.`)
                      }
                    }} aria-label="Lưu trữ series" title="Lưu trữ series"><Trash2 size={15} /></button>
                  </div>
                </div>
                <div className="manager-heading"><span>SÁCH TRONG SERIES</span><button className="button button--secondary button--compact" disabled={busy} onClick={() => setEditor({ kind: 'book', seriesId: selectedSeries.id })}><BookPlus size={14} /> Thêm sách</button></div>
                <div className="book-manager-list">
                  {books.map((book) => (
                    <article className="book-manager-card" data-active={book.id === snapshot.activeBook.id} key={book.id}>
                      <button className="book-manager-card__main" onClick={() => void mutate('workspace:switch-book', { bookId: book.id }, `Đã mở “${book.title}”.`)}>
                        <span className="book-spine"><BookOpenText size={16} /></span><span><strong>{book.title}</strong><small>{book.genre || 'Chưa đặt thể loại'} · {book.targetChapters} chương mục tiêu</small></span>{book.id === snapshot.activeBook.id && <span className="active-pill">ĐANG MỞ</span>}
                      </button>
                      <div className="book-manager-card__actions">
                        <button className="icon-button" disabled={busy} onClick={() => setEditor({ kind: 'book', seriesId: selectedSeries.id, value: book })} aria-label={`Sửa ${book.title}`}><Edit3 size={14} /></button>
                        <button className="icon-button danger-action" disabled={busy} onClick={() => {
                          if (window.confirm(`Lưu trữ sách “${book.title}” và toàn bộ chương? Dữ liệu vẫn được giữ trong database.`)) {
                            void mutate('workspace:archive-book', { id: book.id }, `Đã lưu trữ sách “${book.title}”.`)
                          }
                        }} aria-label={`Lưu trữ ${book.title}`}><Trash2 size={14} /></button>
                      </div>
                    </article>
                  ))}
                  {books.length === 0 && <div className="manager-empty"><BookPlus size={22} /><p>Series này chưa có sách.</p><button className="button button--secondary" onClick={() => setEditor({ kind: 'book', seriesId: selectedSeries.id })}>Tạo sách đầu tiên</button></div>}
                </div>
              </>
            )}
          </section>
        </div>
        {editor?.kind === 'series' && <SeriesEditor editor={editor} busy={busy} onCancel={() => setEditor(null)} onSave={async (input) => {
          const updated = await mutate(editor.value ? 'workspace:update-series' : 'workspace:create-series', editor.value ? { ...input, id: editor.value.id } : input, editor.value ? 'Đã cập nhật series.' : 'Đã tạo series mới.')
          if (updated) {
            if (!editor.value) setSelectedSeriesId(updated.series[0]?.id ?? selectedSeriesId)
            setEditor(null)
          }
        }} />}
        {editor?.kind === 'book' && <BookEditor editor={editor} series={snapshot.series} busy={busy} onCancel={() => setEditor(null)} onSave={async (input) => {
          const updated = await mutate(editor.value ? 'workspace:update-book' : 'workspace:create-book', editor.value ? { ...input, id: editor.value.id } : input, editor.value ? 'Đã cập nhật sách.' : 'Đã tạo và mở sách mới.')
          if (updated) {
            setSelectedSeriesId(updated.activeBook.seriesId)
            setEditor(null)
          }
        }} />}
      </div>
    </div>
  )
}

function SeriesEditor({ editor, busy, onCancel, onSave }: {
  editor: Extract<ProjectEditor, { kind: 'series' }>
  busy: boolean
  onCancel: () => void
  onSave: (input: { name: string; description: string }) => void
}): ReactNode {
  const [name, setName] = useState(editor.value?.name ?? '')
  const [description, setDescription] = useState(editor.value?.description ?? '')
  return (
    <div className="inline-editor">
      <div className="inline-editor__head"><div><span className="panel-kicker">{editor.value ? 'CHỈNH SỬA' : 'SERIES MỚI'}</span><h3>{editor.value ? editor.value.name : 'Tạo không gian cho một series'}</h3></div><button className="icon-button" onClick={onCancel} aria-label="Đóng biểu mẫu"><X size={15} /></button></div>
      <div className="form-grid"><label><span>Tên series</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={180} /></label><label className="form-grid__wide"><span>Mô tả</span><textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} /></label></div>
      <div className="dialog__actions"><button className="button button--secondary" onClick={onCancel}>Hủy</button><button className="button button--primary" disabled={busy || !name.trim()} onClick={() => onSave({ name: name.trim(), description: description.trim() })}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Lưu series</button></div>
    </div>
  )
}

function BookEditor({ editor, series, busy, onCancel, onSave }: {
  editor: Extract<ProjectEditor, { kind: 'book' }>
  series: Series[]
  busy: boolean
  onCancel: () => void
  onSave: (input: { seriesId: string; title: string; genre: string; status: Book['status']; targetChapters: number }) => void
}): ReactNode {
  const [seriesId, setSeriesId] = useState(editor.value?.seriesId ?? editor.seriesId)
  const [title, setTitle] = useState(editor.value?.title ?? '')
  const [genre, setGenre] = useState(editor.value?.genre ?? '')
  const [status, setStatus] = useState<Book['status']>(editor.value?.status ?? 'planning')
  const [targetChapters, setTargetChapters] = useState(editor.value?.targetChapters ?? 24)
  return (
    <div className="inline-editor">
      <div className="inline-editor__head"><div><span className="panel-kicker">{editor.value ? 'CHỈNH SỬA' : 'SÁCH MỚI'}</span><h3>{editor.value ? editor.value.title : 'Thêm một sách vào thư viện'}</h3></div><button className="icon-button" onClick={onCancel} aria-label="Đóng biểu mẫu"><X size={15} /></button></div>
      <div className="form-grid">
        <label><span>Series</span><select value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>{series.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label><span>Trạng thái</span><select value={status} onChange={(event) => setStatus(event.target.value as Book['status'])}><option value="planning">Lên kế hoạch</option><option value="writing">Đang viết</option><option value="reviewing">Đang duyệt</option><option value="completed">Hoàn thành</option></select></label>
        <label className="form-grid__wide"><span>Tên sách</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} /></label>
        <label><span>Thể loại</span><input value={genre} onChange={(event) => setGenre(event.target.value)} maxLength={180} /></label>
        <label><span>Số chương mục tiêu</span><input type="number" min={1} max={5000} value={targetChapters} onChange={(event) => setTargetChapters(Number(event.target.value))} /></label>
      </div>
      <div className="dialog__actions"><button className="button button--secondary" onClick={onCancel}>Hủy</button><button className="button button--primary" disabled={busy || !title.trim() || targetChapters < 1} onClick={() => onSave({ seriesId, title: title.trim(), genre: genre.trim(), status, targetChapters })}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Lưu sách</button></div>
    </div>
  )
}

function ChapterDialog({ bookId, chapter, onClose, onSnapshot, onToast }: {
  bookId: string
  chapter?: Chapter
  onClose: () => void
  onSnapshot: (value: BootstrapSnapshot, chapterId?: string) => void
  onToast: (message: string, tone?: Toast['tone']) => void
}): ReactNode {
  const [title, setTitle] = useState(chapter?.title ?? '')
  const [summary, setSummary] = useState(chapter?.summary ?? '')
  const [status, setStatus] = useState<Chapter['status']>(chapter?.status ?? 'planned')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (chapter) {
        const updated = await window.novelAgent.invoke<BootstrapSnapshot>('workspace:update-chapter', { id: chapter.id, title: title.trim(), summary: summary.trim(), status })
        onSnapshot(updated, chapter.id)
        onToast(`Đã cập nhật chương ${chapter.number}.`, 'success')
      } else {
        const result = await window.novelAgent.invoke<{ snapshot: BootstrapSnapshot; chapterId: string }>('workspace:create-chapter', { bookId, title: title.trim(), summary: summary.trim(), status })
        onSnapshot(result.snapshot, result.chapterId)
        onToast('Đã tạo chương mới.', 'success')
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể lưu chương.')
    } finally {
      setBusy(false)
    }
  }

  const archive = async (): Promise<void> => {
    if (!chapter || !window.confirm(`Lưu trữ chương ${chapter.number} “${chapter.title}”? Nội dung và lịch sử phiên bản vẫn được giữ trong database.`)) return
    setBusy(true)
    try {
      const updated = await window.novelAgent.invoke<BootstrapSnapshot>('workspace:archive-chapter', { id: chapter.id })
      onSnapshot(updated)
      onToast(`Đã lưu trữ chương ${chapter.number}.`, 'success')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không thể lưu trữ chương.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop dialog-backdrop--nested" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="chapter-dialog-title">
        <div className="dialog__head"><div><span className="eyebrow">{chapter ? `CHƯƠNG ${String(chapter.number).padStart(2, '0')}` : 'CHƯƠNG MỚI'}</span><h2 id="chapter-dialog-title">{chapter ? 'Thông tin chương' : 'Tạo chương tiếp theo'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={17} /></button></div>
        <div className="form-grid">
          <label className="form-grid__wide"><span>Tiêu đề chương</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} /></label>
          <label><span>Trạng thái</span><select value={status} onChange={(event) => setStatus(event.target.value as Chapter['status'])}><option value="planned">Đã lên kế hoạch</option><option value="drafting">Đang viết</option><option value="review">Đang duyệt</option><option value="approved">Đã duyệt</option></select></label>
          <label className="form-grid__wide"><span>Tóm tắt / mục đích</span><textarea rows={4} value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={8000} /></label>
        </div>
        {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
        <div className="dialog__actions dialog__actions--split">{chapter ? <button className="button button--danger" disabled={busy} onClick={() => void archive()}><Trash2 size={15} /> Lưu trữ</button> : <span />}<div><button className="button button--secondary" onClick={onClose}>Hủy</button><button className="button button--primary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} {chapter ? 'Lưu thay đổi' : 'Tạo chương'}</button></div></div>
      </div>
    </div>
  )
}

function ProviderDialog({ kind, existing, onClose, onSaved }: { kind: Exclude<ProviderKind, 'demo'>; existing?: ProviderConnection; onClose: () => void; onSaved: () => void }): ReactNode {
  const [name, setName] = useState(existing?.name ?? providerName(kind))
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? DEFAULT_ENDPOINTS[kind])
  const [model, setModel] = useState(existing?.model ?? DEFAULT_MODELS[kind])
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="provider-title">
        <div className="dialog__head"><div><span className="eyebrow">KẾT NỐI BYOK</span><h2 id="provider-title">{providerName(kind)}</h2></div><button className="icon-button" onClick={onClose} aria-label="Đóng"><X size={17} /></button></div>
        <div className="form-grid">
          <label><span>Tên kết nối</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Model mặc định</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
          <label className="form-grid__wide"><span>Endpoint</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
          <label className="form-grid__wide"><span>{kind === 'ollama' ? 'API key (không bắt buộc)' : 'API key'}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={existing ? 'Nhập khóa mới để thay đổi' : 'Chỉ được mã hóa sau khi bấm Lưu'} /></label>
        </div>
        <div className="security-note"><ShieldCheck size={17} /><p>Khóa được mã hóa bằng DPAPI gắn với tài khoản Windows hiện tại. Ứng dụng khác chạy cùng tài khoản vẫn có thể là một phần của bề mặt rủi ro.</p></div>
        {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
        <div className="dialog__actions"><button className="button button--secondary" onClick={onClose}>Hủy</button><button className="button button--primary" disabled={saving || (!apiKey && !existing)} onClick={async () => { setSaving(true); setError(''); try { await window.novelAgent.vault.save({ kind, name, endpoint, model, apiKey }); onSaved() } catch (cause) { setError(cause instanceof Error ? cause.message : 'Không thể lưu kết nối.') } finally { setSaving(false) } }}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />} Lưu an toàn</button></div>
      </div>
    </div>
  )
}

function Inspector({ snapshot, tab, onTab, onClose }: { snapshot: BootstrapSnapshot; tab: InspectorTab; onTab: (value: InspectorTab) => void; onClose: () => void }): ReactNode {
  return (
    <aside className="inspector">
      <div className="inspector__head"><div className="inspector-tabs">{(['brief', 'canon', 'research'] as const).map((item) => <button key={item} data-active={tab === item} onClick={() => onTab(item)}>{item === 'brief' ? 'Brief' : item === 'canon' ? 'Canon' : 'Nguồn'}</button>)}</div><button className="icon-button" onClick={onClose} aria-label="Đóng bảng"><X size={15} /></button></div>
      {tab === 'brief' && <BriefInspector snapshot={snapshot} />}
      {tab === 'canon' && <CanonInspector snapshot={snapshot} />}
      {tab === 'research' && <ResearchInspector />}
    </aside>
  )
}

function BriefInspector({ snapshot }: { snapshot: BootstrapSnapshot }): ReactNode {
  return (
    <div className="inspector-scroll">
      <div className="readiness-card"><div className="readiness-ring" style={{ '--value': `${snapshot.readiness * 3.6}deg` } as React.CSSProperties}><span>{snapshot.readiness}%</span></div><div><strong>Định hướng tác giả</strong><p>{snapshot.readiness === 100 ? 'Đã đủ dữ kiện nền tảng' : 'Còn một quyết định cần xác nhận'}</p></div></div>
      <div className="inspector-section-title"><span>CÁC TRƯỜNG</span><button disabled title="Chỉnh brief trực tiếp sẽ có trong sprint sau">Chỉnh sửa</button></div>
      <div className="brief-field-list">
        {snapshot.briefFields.map((field) => (
          <div className="brief-field" key={field.key} data-state={field.status}>
            <span className="brief-field__state">{field.status === 'unknown' ? <CircleAlert size={13} /> : <Check size={13} />}</span>
            <div><strong>{field.label}</strong><p>{field.valuePreview}</p></div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CanonInspector({ snapshot }: { snapshot: BootstrapSnapshot }): ReactNode {
  return <div className="inspector-scroll"><div className="inspector-section-title"><span>KÝ ỨC CHƯƠNG</span><button disabled>{snapshot.chapterSummaries.length} bản</button></div>{snapshot.chapterSummaries.slice(0, 4).map((summary) => <div className="mini-fact" key={summary.id}><span className="canon-icon"><BookOpenText size={14} /></span><div><strong>Chương {summary.chapterNumber} · {summary.chapterTitle}</strong><p>{summary.summary}</p><small>Document V{summary.sourceVersion} · {summary.tokenEstimate} token</small></div></div>)}<div className="inspector-section-title"><span>CANON GẦN ĐÂY</span><button disabled title="Bạn đang xem toàn bộ canon hiện có">Xem tất cả</button></div>{snapshot.canon.map((fact) => <div className="mini-fact" key={fact.id}><span className={`canon-icon canon-icon--${fact.category}`}>{canonIcon(fact.category)}</span><div><strong>{fact.subject}</strong><p>{fact.fact}</p><small>{Math.round(fact.confidence * 100)}% tin cậy</small></div></div>)}</div>
}

function ResearchInspector(): ReactNode {
  return (
    <div className="inspector-scroll">
      <div className="empty-inspector"><Search size={22} /><h3>Chưa có nguồn nghiên cứu</h3><p>Khi agent cần kiểm chứng bối cảnh, URL, trích đoạn và mức tin cậy sẽ xuất hiện ở đây.</p><span className="chip"><Cloud size={13} /> Tự động có nguồn</span></div>
    </div>
  )
}

function JobTray({ snapshot, onOpen }: { snapshot: BootstrapSnapshot; onOpen: () => void }): ReactNode {
  const job = snapshot.jobs[0]
  const needsReview = job?.status === 'waiting_review' || snapshot.reviewArtifacts.length > 0
  const isActive = job && !needsReview && !['completed', 'cancelled', 'failed', 'paused', 'interrupted', 'billing_unknown'].includes(job.status)
  return (
    <footer className="job-tray">
      <div className="job-tray__identity"><BrainCircuit size={15} /><strong>AI WORKFLOW</strong><span className={`status-dot ${isActive ? 'status-dot--amber' : needsReview ? 'status-dot--good' : ''}`} /></div>
      {job ? <><div className="job-tray__current"><span>{job.label}</span><small>{job.detail}</small></div><div className="job-progress"><span style={{ width: `${job.progress}%` }} /></div><strong className="job-percent">{Math.round(job.progress)}%</strong></> : <span className="job-tray__idle">Không có tác vụ đang chạy</span>}
      <div className="job-tray__meta"><span>{((job?.inputTokens ?? 0) + (job?.outputTokens ?? 0)).toLocaleString('vi-VN')} token</span><span>{formatEstimatedCost(job?.estimatedCost ?? 0, job?.costStatus ?? 'not_applicable')}</span>{snapshot.reviewArtifacts.length > 0 && <span className="review-count">{snapshot.reviewArtifacts.length} chờ duyệt</span>}<button className="icon-button" onClick={onOpen} aria-label="Mở hàng đợi" title="Hàng đợi & Review Center"><ChevronDown size={14} /></button></div>
    </footer>
  )
}

function ToastStack({ items }: { items: Toast[] }): ReactNode {
  return <div className="toast-stack" aria-live="polite">{items.map((item) => <div className="toast" data-tone={item.tone} key={item.id}>{item.tone === 'success' ? <Check size={16} /> : item.tone === 'danger' ? <CircleAlert size={16} /> : <Sparkles size={16} />}<span>{item.message}</span></div>)}</div>
}

function RecoverySafeMode({ status, onRefresh }: { status: RecoveryStatus; onRefresh: () => void }): ReactNode {
  const [busy, setBusy] = useState<'restore' | 'import' | 'restart' | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const recover = async (kind: 'restore' | 'import'): Promise<void> => {
    setBusy(kind)
    setMessage(null)
    try {
      const result = kind === 'restore'
        ? await window.novelAgent.restoreBackup()
        : await window.novelAgent.projectArchive.import()
      if (result) setMessage('Database đã được thay an toàn. Novel Agent Studio đang khởi động lại…')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Không thể hoàn tất khôi phục dữ liệu.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="recovery-screen">
      <div className="recovery-brand"><span className="brand-mark brand-mark--large"><GalleryVerticalEnd size={22} /></span><div><strong>Novel Agent Studio</strong><small>SQLite Safe Mode</small></div></div>
      <main className="recovery-panel">
        <div className="recovery-panel__icon"><ShieldAlert size={26} /></div>
        <span className="eyebrow">DỮ LIỆU ĐƯỢC KHÓA CHỈ ĐỌC</span>
        <h1>Studio đang ở Safe Mode</h1>
        <p>Ứng dụng đã dừng Application Runtime trước khi lỗi có thể tác động thêm tới workspace. Chỉ các thao tác kiểm tra và khôi phục dữ liệu được cho phép.</p>
        <div className="recovery-diagnostic" role="status"><strong>{recoveryReasonLabel(status.reason)}</strong><span>{status.detail}</span><small>{status.databasePath}</small></div>
        <div className="recovery-actions">
          <button className="button button--primary" disabled={Boolean(busy)} onClick={() => void recover('restore')}>{busy === 'restore' ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />} Khôi phục backup</button>
          <button className="button button--secondary" disabled={Boolean(busy)} onClick={() => void recover('import')}>{busy === 'import' ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />} Nhập project archive</button>
        </div>
        <div className="recovery-secondary-actions">
          <button className="text-button" disabled={Boolean(busy)} onClick={onRefresh}><RefreshCw size={13} /> Kiểm tra lại</button>
          <button className="text-button" disabled={Boolean(busy)} onClick={async () => { setBusy('restart'); await window.novelAgent.recovery.restart() }}>Khởi động lại ứng dụng</button>
        </div>
        {message && <div className="recovery-message" role="alert">{message}</div>}
        <div className="recovery-points recovery-points--safe"><div><span>ĐIỂM PHỤC HỒI TỰ ĐỘNG</span><small>{status.recoveryPoints.length} bản được phát hiện</small></div>{status.recoveryPoints.slice(0, 4).map((point) => <div className="recovery-point" key={point.path}><span data-integrity={point.integrity} /><div><strong>{point.kind === 'migration' ? 'Trước migration' : 'Trước restore'}</strong><small>{new Date(point.createdAt).toLocaleString('vi-VN')} · {formatBytes(point.sizeBytes)}</small></div></div>)}{status.recoveryPoints.length === 0 && <p>Chưa có recovery point tự động. Bạn vẫn có thể chọn backup hoặc project archive bên ngoài.</p>}</div>
      </main>
      <footer>Safe Mode không giải mã hoặc xuất API key.</footer>
    </div>
  )
}

function LoadingScreen(): ReactNode {
  return <div className="loading-screen"><div className="loading-brand"><span className="brand-mark brand-mark--large"><GalleryVerticalEnd size={22} /></span><div><h1>Novel Agent Studio</h1><p>Đang mở không gian sáng tác của bạn…</p></div></div><div className="loading-line"><span /></div></div>
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return <div className="error-screen"><CircleAlert size={28} /><h1>Không thể mở studio</h1><p>{message}</p><button className="button button--primary" onClick={onRetry}>Thử lại</button></div>
}

function LoadingPanel({ label }: { label: string }): ReactNode {
  return <div className="loading-panel"><LoaderCircle size={18} className="spin" />{label}</div>
}

type WorkspaceErrorBoundaryProps = {
  resetKey: Workspace
  children: ReactNode
}

type WorkspaceErrorBoundaryState = {
  error: Error | null
}

class WorkspaceErrorBoundary extends Component<WorkspaceErrorBoundaryProps, WorkspaceErrorBoundaryState> {
  state: WorkspaceErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Không thể hiển thị khu vực làm việc.', error, info.componentStack)
  }

  componentDidUpdate(previousProps: WorkspaceErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <section className="workspace-error" role="alert">
        <CircleAlert size={24} />
        <div>
          <h2>Khu vực này chưa thể hiển thị</h2>
          <p>{this.state.error.message || 'Ứng dụng đã chặn một lỗi giao diện để bảo vệ phần còn lại của workspace.'}</p>
          <small>Hãy chuyển sang khu vực khác rồi quay lại. Dữ liệu bản thảo vẫn an toàn.</small>
        </div>
      </section>
    )
  }
}

function providerName(kind: Exclude<ProviderKind, 'demo'>): string {
  return { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', ollama: 'Ollama Local' }[kind]
}

function providerDescription(kind: Exclude<ProviderKind, 'demo'>): string {
  return { openai: 'Responses API · Structured Outputs', anthropic: 'Messages API · Claude models', gemini: 'Gemini API · Text & hình ảnh', ollama: 'Model chạy cục bộ trên Windows' }[kind]
}

function providerInitial(kind: Exclude<ProviderKind, 'demo'>): string {
  return { openai: 'O', anthropic: 'A', gemini: 'G', ollama: 'OL' }[kind]
}

function providerLabel(kind: ProviderKind): string {
  return kind === 'demo' ? 'Demo' : providerName(kind)
}

function canonLabel(category: string): string {
  return { character: 'Nhân vật', location: 'Địa điểm', rule: 'Quy tắc thế giới', event: 'Sự kiện', object: 'Vật phẩm' }[category] ?? category
}

function canonIcon(category: string): ReactNode {
  if (category === 'character') return <UsersRound size={15} />
  if (category === 'location') return <LibraryBig size={15} />
  if (category === 'rule') return <ShieldCheck size={15} />
  if (category === 'event') return <Clock3 size={15} />
  return <Sparkles size={15} />
}

function exportDescription(format: string): string {
  return { docx: 'Chỉnh sửa tiếp trong Microsoft Word', epub: 'EPUB 3 cho thiết bị đọc sách', pdf: 'Bản in A5 được dàn trang', markdown: 'Văn bản nguồn linh hoạt' }[format] ?? ''
}

function recoveryReasonLabel(reason: RecoveryStatus['reason']): string {
  if (reason === 'database_corrupt') return 'SQLite integrity_check không đạt'
  if (reason === 'database_newer') return 'Database thuộc phiên bản ứng dụng mới hơn'
  if (reason === 'runtime_startup') return 'Application Runtime không thể khởi động'
  if (reason === 'restore_failed') return 'Lần khôi phục gần nhất chưa hoàn tất'
  return 'Cần kiểm tra workspace'
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / 1_048_576).toFixed(1)} MB`
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase('vi')).join('') || 'NA'
}

function outlineStatusLabel(version: OutlineVersion): string {
  if (version.status === 'approved') return 'Đã duyệt'
  if (version.status === 'restored') return `Khôi phục từ V${version.originVersion ?? '?'}`
  return 'Đề xuất chờ duyệt'
}

function presetLabel(preset: WorkflowPreset): string {
  if (preset === 'fast') return 'Nhanh'
  if (preset === 'quality') return 'Chất lượng'
  return 'Cân bằng'
}

function workflowStatusLabel(status: WorkflowRun['status']): string {
  const labels: Record<WorkflowRun['status'], string> = {
    queued: 'Đang xếp hàng',
    running: 'Đang chạy',
    paused: 'Đã tạm dừng',
    waiting_review: 'Chờ duyệt',
    completed: 'Hoàn tất',
    cancelled: 'Đã hủy',
    failed: 'Cần xử lý',
    interrupted: 'Bị gián đoạn',
    billing_unknown: 'Chưa rõ chi phí'
  }
  return labels[status]
}

function artifactKindLabel(kind: WorkflowArtifact['kind']): string {
  const labels: Record<WorkflowArtifact['kind'], string> = {
    brief_handoff: 'BRIEF',
    outline_handoff: 'DÀN Ý',
    scene_plan: 'CẢNH',
    context_packet: 'CONTEXT',
    draft: 'BẢN NHÁP',
    editorial_report: 'BIÊN TẬP',
    revision_plan: 'KẾ HOẠCH SỬA',
    revised_draft: 'BẢN SỬA',
    canon_delta: 'CANON',
    visual_note: 'HÌNH ẢNH'
  }
  return labels[kind]
}

function artifactStatusLabel(status: WorkflowArtifact['status']): string {
  if (status === 'committed') return 'Đã commit'
  if (status === 'approved') return 'Đã duyệt'
  if (status === 'rejected') return 'Đã từ chối'
  return 'Đề xuất'
}

function roleName(snapshot: BootstrapSnapshot, roleId: string): string {
  return snapshot.roles.find((role) => role.id === roleId)?.shortName ?? roleId
}

function extractArtifactDocumentText(artifact: WorkflowArtifact): string {
  return extractDocumentText(artifact.data.document)
}

function extractDocumentText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const record = node as Record<string, unknown>
  const own = typeof record.text === 'string' ? record.text : ''
  const children = Array.isArray(record.content) ? record.content.map(extractDocumentText).filter(Boolean).join(' ') : ''
  return `${own} ${children}`.trim()
}

function formatEstimatedCost(value: number, status: WorkflowRun['costStatus']): string {
  if (status === 'unknown') return 'Chưa xác định'
  if (status === 'not_applicable') return 'Không phát sinh'
  return `$${value.toFixed(4)} ước tính`
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000))
  if (minutes < 1) return 'vừa xong'
  if (minutes < 60) return `${minutes} phút trước`
  return 'hôm nay'
}
