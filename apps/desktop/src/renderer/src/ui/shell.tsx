import type { ReactNode } from 'react'
import {
  BookOpenText,
  BrainCircuit,
  Feather,
  Image,
  LibraryBig,
  ListTree,
  House,
  Settings
} from 'lucide-react'

export type Workspace = 'manuscript' | 'outline' | 'canon' | 'agents' | 'visual' | 'settings'

export function TitleBar(): ReactNode {
  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="brand-mark"><Feather size={15} /></span>
        <span>Novel Agent Studio</span>
        <span className="titlebar__version">STORYWORLD</span>
      </div>
      <div className="titlebar__status"><span className="status-dot status-dot--good" /> Local-first · Đã lưu</div>
    </header>
  )
}

export function AppRail({ workspace, surface, hasBook, onHome, onChange }: {
  workspace: Workspace
  surface: 'library' | 'series-concept' | 'book' | 'settings'
  hasBook: boolean
  onHome: () => void
  onChange: (value: Workspace) => void
}): ReactNode {
  const items: Array<{ id: Workspace; label: string; icon: ReactNode }> = [
    { id: 'manuscript', label: 'Bản thảo', icon: <BookOpenText size={19} /> },
    { id: 'outline', label: 'Dàn ý', icon: <ListTree size={19} /> },
    { id: 'canon', label: 'Story Bible', icon: <LibraryBig size={19} /> },
    { id: 'agents', label: 'AI Studio', icon: <BrainCircuit size={19} /> },
    { id: 'visual', label: 'Visual Studio', icon: <Image size={19} /> }
  ]

  return (
    <nav className="app-rail" aria-label="Khu vực chính">
      <div className="app-rail__atlas-mark" aria-hidden="true"><Feather size={20} /></div>
      <div className="app-rail__primary">
        <button
          className="rail-button"
          data-active={surface === 'library'}
          onClick={onHome}
          aria-label="Thư viện sáng tác"
          aria-current={surface === 'library' ? 'page' : undefined}
          title="Thư viện sáng tác"
        >
          <House size={19} />
          <span className="rail-button__label">Thư viện</span>
          <span className="rail-button__indicator" />
        </button>
        {items.map((item) => (
          <button
            key={item.id}
            className="rail-button"
            data-active={surface === 'book' && workspace === item.id}
            disabled={!hasBook}
            onClick={() => onChange(item.id)}
            aria-label={item.label}
            aria-current={surface === 'book' && workspace === item.id ? 'page' : undefined}
            title={hasBook ? item.label : 'Hãy mở một sách từ Thư viện'}
          >
            {item.icon}
            <span className="rail-button__label">{item.label}</span>
            <span className="rail-button__indicator" />
          </button>
        ))}
      </div>
      <button
        className="rail-button"
        data-active={surface === 'settings'}
        onClick={() => onChange('settings')}
        aria-label="Cài đặt"
        aria-current={surface === 'settings' ? 'page' : undefined}
        title="Cài đặt"
      >
        <Settings size={19} />
        <span className="rail-button__label">Cài đặt</span>
        <span className="rail-button__indicator" />
      </button>
    </nav>
  )
}
