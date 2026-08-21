import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  BookOpenText,
  BookPlus,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Edit3,
  FolderPlus,
  LibraryBig,
  LoaderCircle,
  MessageSquareText,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X
} from 'lucide-react'
import type {
  Book,
  BootstrapSnapshot,
  LibrarySeries,
  LibrarySnapshot,
  ProviderKind,
  SeriesConceptSnapshot
} from '@core/index'

type Notify = (message: string, tone?: 'success' | 'danger' | 'neutral') => void

type LibraryEditor =
  | { kind: 'series'; value?: LibrarySeries }
  | { kind: 'book'; seriesId: string; value?: Book }

export function LibraryDashboard({ snapshot, onSnapshot, onOpenBook, onOpenConcept, onToast }: {
  snapshot: LibrarySnapshot
  onSnapshot: (value: LibrarySnapshot) => void
  onOpenBook: (bookId: string, workspace?: 'manuscript' | 'agents') => void
  onOpenConcept: (seriesId: string) => void
  onToast: Notify
}): ReactNode {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(() => new Set(snapshot.series.map((series) => series.id)))
  const [editor, setEditor] = useState<LibraryEditor | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current)
      snapshot.series.forEach((series) => next.add(series.id))
      return next
    })
  }, [snapshot.series])

  const normalizedQuery = query.trim().toLocaleLowerCase('vi')
  const filteredSeries = useMemo(() => snapshot.series.filter((series) => {
    if (!normalizedQuery) return true
    const books = snapshot.books.filter((book) => book.seriesId === series.id)
    return `${series.name} ${series.description}`.toLocaleLowerCase('vi').includes(normalizedQuery)
      || books.some((book) => `${book.title} ${book.genre}`.toLocaleLowerCase('vi').includes(normalizedQuery))
  }), [normalizedQuery, snapshot.books, snapshot.series])

  const updateLibrary = async (channel: string, payload: unknown, message: string): Promise<LibrarySnapshot | null> => {
    setBusy(true)
    try {
      const updated = await window.novelAgent.invoke<LibrarySnapshot>(channel, payload)
      onSnapshot(updated)
      onToast(message, 'success')
      return updated
    } catch (cause) {
      onToast(cause instanceof Error ? cause.message : 'Không thể cập nhật Thư viện.', 'danger')
      return null
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="library-page">
      <header className="library-header">
        <div>
          <span className="eyebrow">TRUNG TÂM DỰ ÁN</span>
          <h1>Thư viện sáng tác</h1>
          <p>Mở một cuốn sách đang viết hoặc bắt đầu định hướng Series mới cùng Đạo diễn.</p>
        </div>
        <button className="button button--primary" onClick={() => setEditor({ kind: 'series' })} disabled={busy}>
          <FolderPlus size={15} /> Series mới
        </button>
      </header>

      <div className="library-toolbar">
        <label className="library-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm Series, sách hoặc thể loại" aria-label="Tìm trong Thư viện" />
          {query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Xóa tìm kiếm"><X size={14} /></button>}
        </label>
        <div className="library-counts" aria-label="Thống kê Thư viện">
          <span><strong>{snapshot.series.length}</strong> Series</span>
          <span><strong>{snapshot.books.length}</strong> Sách</span>
        </div>
      </div>

      <div className="library-list">
        {filteredSeries.map((series) => {
          const books = snapshot.books.filter((book) => book.seriesId === series.id)
          const isExpanded = expanded.has(series.id)
          return (
            <section className="library-series" key={series.id}>
              <div className="library-series__head">
                <button
                  className="library-series__toggle"
                  onClick={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(series.id)) next.delete(series.id)
                    else next.add(series.id)
                    return next
                  })}
                  aria-expanded={isExpanded}
                >
                  <span className="library-monogram">{initials(series.name)}</span>
                  <span className="library-series__copy">
                    <strong>{series.name}</strong>
                    <small>{series.description || 'Chưa có mô tả cho Series này.'}</small>
                  </span>
                  <span className="library-series__meta">{books.length} sách · {relativeTime(series.updatedAt)}</span>
                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <div className="library-row-actions">
                  <button className="icon-button" disabled={busy} onClick={() => setEditor({ kind: 'series', value: series })} aria-label={`Sửa ${series.name}`} title="Sửa Series"><Edit3 size={14} /></button>
                  <button className="icon-button danger-action" disabled={busy} onClick={() => {
                    if (window.confirm(`Lưu trữ Series “${series.name}” cùng toàn bộ sách và chương? Dữ liệu vẫn được giữ trong database.`)) {
                      void updateLibrary('library:archive-series', { id: series.id }, `Đã lưu trữ Series “${series.name}”.`)
                    }
                  }} aria-label={`Lưu trữ ${series.name}`} title="Lưu trữ Series"><Trash2 size={14} /></button>
                </div>
              </div>

              {isExpanded && (
                <div className="library-books">
                  {books.map((book) => {
                    const progress = Math.round((book.approvedChapters / Math.max(1, book.targetChapters)) * 100)
                    return (
                      <article className="library-book-row" data-active={book.id === snapshot.activeBookId} key={book.id}>
                        <button className="library-book-row__main" onClick={() => onOpenBook(book.id)}>
                          <span className="library-book-icon"><BookOpenText size={16} /></span>
                          <span><strong>{book.title}</strong><small>{book.genre || 'Chưa đặt thể loại'} · {statusLabel(book.status)}</small></span>
                          <span className="library-progress"><span><i style={{ width: `${Math.max(progress, 3)}%` }} /></span><small>{book.approvedChapters}/{book.targetChapters} chương</small></span>
                          {book.id === snapshot.activeBookId && <span className="active-pill">GẦN NHẤT</span>}
                          <ChevronRight size={15} />
                        </button>
                        <div className="library-row-actions">
                          <button className="icon-button" disabled={busy} onClick={() => setEditor({ kind: 'book', seriesId: series.id, value: book })} aria-label={`Sửa ${book.title}`} title="Sửa sách"><Edit3 size={14} /></button>
                          <button className="icon-button danger-action" disabled={busy} onClick={() => {
                            if (window.confirm(`Lưu trữ sách “${book.title}” và toàn bộ chương? Dữ liệu vẫn được giữ trong database.`)) {
                              void updateLibrary('library:archive-book', { id: book.id }, `Đã lưu trữ “${book.title}”.`)
                            }
                          }} aria-label={`Lưu trữ ${book.title}`} title="Lưu trữ sách"><Archive size={14} /></button>
                        </div>
                      </article>
                    )
                  })}

                  {books.length === 0 && (
                    <div className="library-series-empty">
                      <div><MessageSquareText size={20} /><span><strong>Series chưa có Tập 1</strong><small>Trao đổi ý tưởng trước, hoặc tạo sách ngay với brief trống.</small></span></div>
                      <div>
                        <button className="button button--secondary" onClick={() => setEditor({ kind: 'book', seriesId: series.id })}><BookPlus size={14} /> Tạo Tập 1</button>
                        <button className="button button--primary" onClick={() => onOpenConcept(series.id)}><WandSparkles size={14} /> Trò chuyện với Đạo diễn</button>
                      </div>
                    </div>
                  )}

                  {books.length > 0 && (
                    <button className="library-add-book" onClick={() => setEditor({ kind: 'book', seriesId: series.id })} disabled={busy}>
                      <Plus size={14} /> Thêm sách vào {series.name}
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}

        {snapshot.series.length === 0 && (
          <div className="library-empty"><LibraryBig size={28} /><h2>Thư viện đang trống</h2><p>Tạo Series đầu tiên để bắt đầu định hướng cùng Đạo diễn.</p><button className="button button--primary" onClick={() => setEditor({ kind: 'series' })}><FolderPlus size={15} /> Tạo Series</button></div>
        )}
        {snapshot.series.length > 0 && filteredSeries.length === 0 && (
          <div className="library-empty"><Search size={24} /><h2>Không tìm thấy kết quả</h2><p>Thử tên Series, tên sách hoặc một thể loại khác.</p><button className="button button--secondary" onClick={() => setQuery('')}>Xóa tìm kiếm</button></div>
        )}
      </div>

      {editor && <LibraryEditorDialog
        editor={editor}
        series={snapshot.series}
        busy={busy}
        onClose={() => setEditor(null)}
        onSave={async (input) => {
          setBusy(true)
          try {
            if (editor.kind === 'series') {
              if (editor.value) {
                const updated = await window.novelAgent.invoke<LibrarySnapshot>('library:update-series', { ...input, id: editor.value.id })
                onSnapshot(updated)
                onToast('Đã cập nhật Series.', 'success')
              } else {
                const result = await window.novelAgent.invoke<{ snapshot: LibrarySnapshot; seriesId: string }>('library:create-series', input)
                onSnapshot(result.snapshot)
                setEditor(null)
                onToast('Đã tạo Series mới.', 'success')
                onOpenConcept(result.seriesId)
                return
              }
            } else if (editor.value) {
              const updated = await window.novelAgent.invoke<LibrarySnapshot>('library:update-book', { ...input, id: editor.value.id })
              onSnapshot(updated)
              onToast('Đã cập nhật sách.', 'success')
            } else {
              const result = await window.novelAgent.invoke<{ snapshot: LibrarySnapshot; bookId: string }>('library:create-book', input)
              onSnapshot(result.snapshot)
              setEditor(null)
              onToast('Đã tạo sách mới.', 'success')
              onOpenBook(result.bookId)
              return
            }
            setEditor(null)
          } catch (cause) {
            onToast(cause instanceof Error ? cause.message : 'Không thể lưu thay đổi.', 'danger')
          } finally {
            setBusy(false)
          }
        }}
      />}
    </div>
  )
}

export function SeriesConceptStudio({ snapshot, onSnapshot, onHome, onPromoted, onToast }: {
  snapshot: SeriesConceptSnapshot
  onSnapshot: (value: SeriesConceptSnapshot) => void
  onHome: () => void
  onPromoted: (value: BootstrapSnapshot) => void
  onToast: Notify
}): ReactNode {
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [activeProvider, setActiveProvider] = useState<Exclude<ProviderKind, 'demo'> | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [snapshot.messages.length])
  useEffect(() => {
    void window.novelAgent.vault.preferred().then(setActiveProvider).catch(() => setActiveProvider(null))
  }, [])

  const send = async (): Promise<void> => {
    if (!input.trim() || sending) return
    const content = input.trim()
    setInput('')
    setSending(true)
    try {
      const updated = await window.novelAgent.invoke<SeriesConceptSnapshot>('series-concept:message', { seriesId: snapshot.series.id, content })
      onSnapshot(updated)
    } catch (cause) {
      setInput(content)
      onToast(cause instanceof Error ? cause.message : 'Không thể gửi tin nhắn.', 'danger')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="concept-page">
      <header className="concept-header">
        <div className="concept-breadcrumb"><button onClick={onHome}>Thư viện</button><ChevronRight size={13} /><span>{snapshot.series.name}</span></div>
        <div className="concept-header__main">
          <div><span className="eyebrow">ĐỊNH HƯỚNG TRƯỚC TẬP 1</span><h1>{snapshot.series.name}</h1><p>{snapshot.series.description || 'Một Series mới đang chờ bạn định hình.'}</p></div>
          <button className="button button--primary" disabled={sending} onClick={() => setPreviewOpen(true)}><BookPlus size={15} /> Xem trước Tập 1</button>
        </div>
      </header>

      <div className="concept-layout">
        <section className="concept-chat">
          <div className="chat-intro">
            <div className="agent-avatar agent-avatar--director"><WandSparkles size={18} /></div>
            <div><h2>Đạo diễn truyện</h2><p>{activeProvider ? providerName(activeProvider) : 'Demo cục bộ'} · Định hướng cấp Series</p></div>
            <div className="readiness-orb" style={{ '--value': `${snapshot.readiness * 3.6}deg` } as React.CSSProperties}><span>{snapshot.readiness}</span></div>
          </div>
          <div className="message-list">
            {snapshot.messages.length === 0 && <div className="concept-chat-empty"><Sparkles size={20} /><h3>Hãy kể điều đầu tiên bạn hình dung</h3><p>Đạo diễn sẽ lần lượt làm rõ tiền đề, nhân vật, xung đột, giọng kể và hướng kết thúc.</p></div>}
            {snapshot.messages.map((message) => (
              <div key={message.id} className="message" data-role={message.role}>
                {message.role !== 'user' && <div className="message__avatar">{message.role === 'system' ? <ShieldCheck size={14} /> : <Sparkles size={14} />}</div>}
                <div className="message__bubble">
                  {message.role !== 'user' && <strong>{message.role === 'system' ? 'Hệ thống' : 'Đạo diễn'}</strong>}
                  <p>{message.content}</p><time>{formatTime(message.createdAt)}</time>
                </div>
              </div>
            ))}
            {sending && <div className="message"><div className="message__avatar"><Sparkles size={14} /></div><div className="message__bubble typing"><span /><span /><span /></div></div>}
            <div ref={endRef} />
          </div>
          <div className="composer">
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
            }} placeholder="Kể cho Đạo diễn điều bạn hình dung…" rows={3} />
            <div className="composer__footer"><span>Enter để gửi · Shift+Enter xuống dòng</span><button className="send-button" onClick={() => void send()} disabled={!input.trim() || sending} aria-label="Gửi tin nhắn"><Send size={15} /></button></div>
          </div>
        </section>

        <aside className="concept-brief">
          <div className="concept-brief__head"><div className="readiness-ring" style={{ '--value': `${snapshot.readiness * 3.6}deg` } as React.CSSProperties}><span>{snapshot.readiness}%</span></div><div><strong>Brief Tập 1</strong><p>{snapshot.readiness === 100 ? 'Đã đủ dữ kiện nền tảng' : 'Có thể tạo sớm và hoàn thiện sau'}</p></div></div>
          <div className="inspector-section-title"><span>CÁC QUYẾT ĐỊNH</span><small>{snapshot.briefFields.filter((field) => field.status !== 'unknown').length}/{snapshot.briefFields.length}</small></div>
          <div className="brief-field-list">
            {snapshot.briefFields.map((field) => <div className="brief-field" key={field.key} data-state={field.status}><span className="brief-field__state">{field.status === 'unknown' ? <CircleAlert size={13} /> : <Check size={13} />}</span><div><strong>{field.label}</strong><p>{field.valuePreview}</p></div></div>)}
          </div>
        </aside>
      </div>

      {previewOpen && <FirstBookPreviewDialog snapshot={snapshot} onClose={() => setPreviewOpen(false)} onCreate={async (input) => {
        try {
          const book = await window.novelAgent.invoke<BootstrapSnapshot>('series-concept:promote', input)
          onToast('Đã tạo Tập 1 và chuyển toàn bộ định hướng.', 'success')
          onPromoted(book)
        } catch (cause) {
          onToast(cause instanceof Error ? cause.message : 'Không thể tạo Tập 1.', 'danger')
          throw cause
        }
      }} />}
    </div>
  )
}

function LibraryEditorDialog({ editor, series, busy, onClose, onSave }: {
  editor: LibraryEditor
  series: LibrarySeries[]
  busy: boolean
  onClose: () => void
  onSave: (input: { name: string; description: string } | { seriesId: string; title: string; genre: string; status: Book['status']; targetChapters: number }) => void
}): ReactNode {
  const isSeries = editor.kind === 'series'
  const book = editor.kind === 'book' ? editor.value : undefined
  const seriesValue = editor.kind === 'series' ? editor.value : undefined
  const [name, setName] = useState(seriesValue?.name ?? '')
  const [description, setDescription] = useState(seriesValue?.description ?? '')
  const [seriesId, setSeriesId] = useState(editor.kind === 'book' ? (book?.seriesId ?? editor.seriesId) : '')
  const [title, setTitle] = useState(book?.title ?? '')
  const [genre, setGenre] = useState(book?.genre ?? '')
  const [status, setStatus] = useState<Book['status']>(book?.status ?? 'planning')
  const [targetChapters, setTargetChapters] = useState(book?.targetChapters ?? 24)
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className="dialog library-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="library-editor-title">
        <div className="dialog__head"><div><span className="eyebrow">{isSeries ? 'SERIES' : 'SÁCH'}</span><h2 id="library-editor-title">{isSeries ? seriesValue ? 'Chỉnh sửa Series' : 'Tạo Series mới' : book ? 'Chỉnh sửa sách' : 'Tạo sách mới'}</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Đóng"><X size={16} /></button></div>
        {isSeries ? <div className="form-grid"><label><span>Tên Series</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={180} /></label><label className="form-grid__wide"><span>Mô tả</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} /></label></div> : <div className="form-grid"><label><span>Series</span><select value={seriesId} onChange={(event) => setSeriesId(event.target.value)}>{series.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label><span>Tên sách</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} /></label><label><span>Thể loại</span><input value={genre} onChange={(event) => setGenre(event.target.value)} maxLength={180} /></label><label><span>Trạng thái</span><select value={status} onChange={(event) => setStatus(event.target.value as Book['status'])}><option value="planning">Lên kế hoạch</option><option value="writing">Đang viết</option><option value="reviewing">Đang duyệt</option><option value="completed">Hoàn thành</option></select></label><label><span>Số chương mục tiêu</span><input type="number" min={1} max={5000} value={targetChapters} onChange={(event) => setTargetChapters(Number(event.target.value))} /></label></div>}
        <div className="dialog__actions"><button className="button button--secondary" onClick={onClose} disabled={busy}>Hủy</button><button className="button button--primary" disabled={busy || (isSeries ? !name.trim() : !seriesId || !title.trim() || targetChapters < 1)} onClick={() => onSave(isSeries ? { name: name.trim(), description: description.trim() } : { seriesId, title: title.trim(), genre: genre.trim(), status, targetChapters })}>{busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Lưu</button></div>
      </div>
    </div>
  )
}

function FirstBookPreviewDialog({ snapshot, onClose, onCreate }: {
  snapshot: SeriesConceptSnapshot
  onClose: () => void
  onCreate: (input: { seriesId: string; conceptVersionId: string; title: string; genre: string; status: 'planning'; targetChapters: number }) => Promise<void>
}): ReactNode {
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState(snapshot.brief.genres.join(' · '))
  const [targetChapters, setTargetChapters] = useState(snapshot.brief.targetChapters)
  const [busy, setBusy] = useState(false)
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className="dialog first-book-dialog" role="dialog" aria-modal="true" aria-labelledby="first-book-title">
        <div className="dialog__head"><div><span className="eyebrow">BẢN XEM TRƯỚC · {snapshot.readiness}% BRIEF</span><h2 id="first-book-title">Tạo Tập 1</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Đóng"><X size={16} /></button></div>
        <div className="first-book-series"><span className="library-monogram">{initials(snapshot.series.name)}</span><div><small>SERIES</small><strong>{snapshot.series.name}</strong></div></div>
        {snapshot.readiness < 100 && <div className="notice"><CircleAlert size={15} /><div><strong>Brief chưa hoàn chỉnh</strong><p>Bạn vẫn có thể tạo Tập 1 và tiếp tục trò chuyện với Đạo diễn trong sách.</p></div></div>}
        <div className="form-grid"><label className="form-grid__wide"><span>Tên Tập 1</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} placeholder="Tên sách sẽ xuất hiện trong Thư viện" /></label><label><span>Thể loại</span><input value={genre} onChange={(event) => setGenre(event.target.value)} maxLength={180} /></label><label><span>Số chương mục tiêu</span><input type="number" min={1} max={5000} value={targetChapters} onChange={(event) => setTargetChapters(Number(event.target.value))} /></label><label><span>Trạng thái</span><input value="Lên kế hoạch" readOnly /></label></div>
        <div className="dialog__actions"><button className="button button--secondary" onClick={onClose} disabled={busy}>Quay lại chat</button><button className="button button--primary" disabled={busy || !title.trim() || targetChapters < 1 || targetChapters > 5000} onClick={async () => { setBusy(true); try { await onCreate({ seriesId: snapshot.series.id, conceptVersionId: snapshot.conceptVersionId, title: title.trim(), genre: genre.trim(), status: 'planning', targetChapters }) } catch { return } finally { setBusy(false) } }}>{busy ? <LoaderCircle size={15} className="spin" /> : <BookPlus size={15} />} Tạo và mở Tập 1</button></div>
      </div>
    </div>
  )
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase('vi')).join('') || 'NA'
}

function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime()
  const days = Math.floor(delta / 86_400_000)
  if (days <= 0) return 'Hôm nay'
  if (days === 1) return 'Hôm qua'
  if (days < 30) return `${days} ngày trước`
  return new Date(value).toLocaleDateString('vi-VN')
}

function statusLabel(status: Book['status']): string {
  if (status === 'writing') return 'Đang viết'
  if (status === 'reviewing') return 'Đang duyệt'
  if (status === 'completed') return 'Hoàn thành'
  return 'Lên kế hoạch'
}

function providerName(kind: Exclude<ProviderKind, 'demo'>): string {
  if (kind === 'openai') return 'OpenAI'
  if (kind === 'anthropic') return 'Anthropic'
  if (kind === 'gemini') return 'Google Gemini'
  return 'Ollama cục bộ'
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
}
