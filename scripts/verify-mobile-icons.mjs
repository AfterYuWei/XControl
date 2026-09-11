import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const platform = process.argv[2]
const projectRoot = resolve(import.meta.dirname, '..')

const platformPaths = {
  android: {
    source: join(projectRoot, 'src-tauri/icons/android'),
    target: join(projectRoot, 'src-tauri/gen/android/app/src/main/res'),
  },
  ios: {
    source: join(projectRoot, 'src-tauri/icons/ios'),
    target: join(projectRoot, 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset'),
  },
}

if (!(platform in platformPaths)) {
  throw new Error('用法: node scripts/verify-mobile-icons.mjs <android|ios>')
}

const { source, target } = platformPaths[platform]

if (!existsSync(target)) {
  throw new Error(
    `找不到 ${relative(projectRoot, target)}，请先运行 npm run ${platform}:init`,
  )
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const sourceFiles = listFiles(source).filter((path) => {
  if (platform === 'ios') return path.endsWith('.png')
  return statSync(path).isFile()
})

const failures = []

for (const sourceFile of sourceFiles) {
  const relativePath = relative(source, sourceFile)
  const targetFile = join(target, relativePath)

  if (!existsSync(targetFile)) {
    failures.push(`${relativePath}: 原生工程中缺失`)
    continue
  }

  if (sha256(sourceFile) !== sha256(targetFile)) {
    failures.push(`${relativePath}: 原生工程仍是旧图标`)
  }
}

if (failures.length > 0) {
  throw new Error(`移动端图标校验失败:\n${failures.join('\n')}`)
}

console.log(`已确认 ${sourceFiles.length} 个 ${platform} 图标写入原生工程。`)
