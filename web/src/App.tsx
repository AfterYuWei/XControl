import { Layout } from '@/components/Layout'
import { TooltipProvider } from '@/components/ui/tooltip'
import { initTheme } from '@/store/settings'

// Initialize theme on app load
initTheme()

function App() {
  return (
    <TooltipProvider>
      <Layout />
    </TooltipProvider>
  )
}

export default App
