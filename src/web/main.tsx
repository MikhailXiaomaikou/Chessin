import { installWebShim } from './web-shim'

// Install the web API shim before anything else loads
installWebShim()

// Now load the app
import React, { useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import App from '../renderer/src/App'
import { useEngineStore } from '../renderer/src/stores/engineStore'
import '../renderer/src/styles/globals.css'

// Auto-add Stockfish WASM on first launch if no engines exist
function AutoStockfishSetup() {
  const initRef = useRef(false)

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    const engines = useEngineStore.getState().engines
    if (engines.length > 0) return
    if (!window.electronAPI?.engine) return

    ;(async () => {
      const id = `engine_${Date.now()}`
      const result = await window.electronAPI.engine.add(id, '__stockfish_wasm__')
      if (result.success) {
        useEngineStore.getState().addEngine({
          id,
          name: result.identity.name || 'Stockfish',
          path: '__stockfish_wasm__',
          isActive: true,
          multiPv: 3
        })
        await window.electronAPI.engine.setOption(id, 'MultiPV', 3)

        const options = result.options as { name: string }[]
        if (options.some((o) => o.name === 'UCI_ShowWDL')) {
          await window.electronAPI.engine.setOption(id, 'UCI_ShowWDL', true)
        }
      }
    })()
  }, [])

  return null
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AutoStockfishSetup />
    <App />
  </React.StrictMode>
)
