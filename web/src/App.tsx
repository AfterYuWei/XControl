import { Layout } from '@/components/Layout'
import { initTheme } from '@/store/settings'

// Initialize theme on app load
initTheme()

function App() {
  return <Layout />
}

export default App
