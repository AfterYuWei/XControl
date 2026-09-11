import { lazy, Suspense } from 'react'
import { Layout } from '@/components/Layout'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isMobileRuntime } from '@/lib/platform'
import { initTheme } from '@/store/settings'

// MobileLayout（含 motion 手势库）走动态导入：桌面运行时不加载移动 bundle。
const MobileLayout = lazy(() =>
  import('@/components/MobileLayout').then((module) => ({ default: module.MobileLayout })),
)

// Initialize theme on app load
initTheme()

function App() {
  return (
    <TooltipProvider>
      {isMobileRuntime()
        ? (
          <Suspense fallback={null}>
            <MobileLayout />
          </Suspense>
        )
        : <Layout />}
    </TooltipProvider>
  )
}

export default App
