import { Layout } from '@/components/Layout'
import { MobileLayout } from '@/components/MobileLayout'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isMobileRuntime } from '@/lib/platform'
import { initTheme } from '@/store/settings'

// Initialize theme on app load
initTheme()

function App() {
  return (
    <TooltipProvider>
      {isMobileRuntime() ? <MobileLayout /> : <Layout />}
    </TooltipProvider>
  )
}

export default App
