import { useEffect, useState } from 'react'
import { me, type Session } from './api'
import { Join } from './Join'
import { Workspace } from './Workspace'

export const App = () => {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void me().then(found => {
      setSession(found)
      setReady(true)
    })
  }, [])

  if (!ready) return <div className="boot">loading…</div>
  if (!session) return <Join onSession={setSession} notice={notice} />
  return (
    <Workspace
      session={session}
      onLeave={reason => {
        setNotice(reason ?? '')
        setSession(null)
      }}
    />
  )
}
