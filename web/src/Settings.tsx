import { useState } from 'react'
import type { Session } from './api'
import { Accounts } from './Login'
import { Tools } from './Tools'

export type SettingsTab = 'accounts' | 'tools'

export const Settings = ({ session, tab, onTab, onClose, onNote, onChanged }: { session: Session; tab: SettingsTab; onTab: (tab: SettingsTab) => void; onClose: () => void; onNote: (note: string) => void; onChanged: () => void }) => (
  <div className="modal" onClick={onClose}>
    <div className="modal-card" onClick={event => event.stopPropagation()}>
      <header>
        <h2>Settings</h2>
        <button className="link" onClick={onClose}>
          close
        </button>
      </header>
      <div className="rail-tabs settings-tabs">
        <button className={tab === 'accounts' ? 'rail-tab on' : 'rail-tab'} onClick={() => onTab('accounts')}>
          accounts
        </button>
        <button className={tab === 'tools' ? 'rail-tab on' : 'rail-tab'} onClick={() => onTab('tools')}>
          tools and keys
        </button>
      </div>
      {tab === 'accounts' ? <Accounts session={session} onChanged={onChanged} /> : <Tools session={session} onNote={onNote} />}
    </div>
  </div>
)
