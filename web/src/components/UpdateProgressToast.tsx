import { toast } from '@/components/ui/toast'
import type { UpdateDownloadProgress } from '@/lib/updater'
import { UpdateProgressDetails } from '@/components/UpdateProgressDetails'

const UPDATE_TOAST_ID = 'xcontrol-app-update'

interface RunUpdateWithToastOptions {
  version?: string
}

/**
 * 用同一个 Sonner toast 展示下载和安装状态。返回 false 表示失败，错误已经
 * 转换为用户可见 toast，调用方无需再处理未捕获的 Promise rejection。
 */
export async function runUpdateWithToast(
  install: (onProgress: (progress: UpdateDownloadProgress) => void) => Promise<void>,
  options: RunUpdateWithToastOptions = {},
): Promise<boolean> {
  const showProgress = (progress: UpdateDownloadProgress) => {
    toast.loading(
      progress.phase === 'installing'
        ? '正在安装更新…'
        : `正在下载${options.version ? ` v${options.version}` : '更新'}…`,
      {
        id: UPDATE_TOAST_ID,
        description: <UpdateProgressDetails progress={progress} />,
        duration: Number.POSITIVE_INFINITY,
        closeButton: false,
      },
    )
  }

  showProgress({
    phase: 'downloading',
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    bytesPerSecond: 0,
  })

  try {
    await install(showProgress)
    toast.success('更新完成，应用即将重启', {
      id: UPDATE_TOAST_ID,
      duration: 5000,
    })
    return true
  } catch (error) {
    toast.error('更新失败', {
      id: UPDATE_TOAST_ID,
      description: error instanceof Error ? error.message : String(error),
      duration: 10000,
      closeButton: true,
    })
    return false
  }
}
