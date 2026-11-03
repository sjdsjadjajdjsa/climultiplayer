import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource/instrument-sans/latin-400.css'
import '@fontsource/instrument-sans/latin-500.css'
import '@fontsource/instrument-sans/latin-600.css'
import '@fontsource/commit-mono/latin-400.css'
import '@fontsource/commit-mono/latin-700.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
