#!/usr/bin/env node

// 为 tauri android init 生成的 Gradle 项目打签名补丁。
//
// 背景：`tauri android init` 生成的 app/build.gradle.kts 不会读取
// keystore.properties，debug 构建永远使用 runner 本机随机生成的 debug 密钥，
// 导致每次 CI 构建出的 APK 签名都不同，无法覆盖安装（只能卸载重装）。
//
// 本脚本在存在 src-tauri/gen/android/keystore.properties 时给
// app/build.gradle.kts 注入 `eizhu` signingConfig，并让 debug / release
// 构建在 keystore.properties 存在时使用它。所有分发出去的 APK 因此共享
// 同一上传密钥签名，测试包与正式包之间也能直接覆盖升级。
//
// 脚本幂等：已打过补丁（含 eizhu-signing-patch 标记）或缺文件时直接跳过。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const gradlePath = fileURLToPath(
  new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url),
)
if (!existsSync(gradlePath)) {
  console.log('[eizhu] gen/android 项目尚未初始化，跳过签名补丁')
  process.exit(0)
}

let content = readFileSync(gradlePath, 'utf8')
if (content.includes('eizhu-signing-patch')) {
  console.log('[eizhu] 签名补丁已存在，跳过')
  process.exit(0)
}

const MARKER = 'eizhu-signing-patch'
// 注意：build.gradle.kts 中 `java` 会被脚本作用域的 java 扩展访问器遮蔽，
// 不能写 java.util.Properties() 全限定名，必须用短名 Properties()；
// 文件顶部需要 `import java.util.Properties`（模板自带时不再重复添加）。
const PROPERTIES_IMPORT = 'import java.util.Properties'
if (!content.includes(PROPERTIES_IMPORT)) {
  content = `${PROPERTIES_IMPORT}\n${content}`
}
const signingConfig = [
  `    // ${MARKER}: 存在 keystore.properties 时使用固定上传密钥签名，`,
  '    // 保证 APK 之间可以覆盖升级（debug 构建不再依赖 runner 随机 debug 密钥）。',
  '    signingConfigs {',
  '        create("eizhu") {',
  '            val keystorePropertiesFile = rootProject.file("keystore.properties")',
  '            if (keystorePropertiesFile.exists()) {',
  '                val keystoreProperties = Properties()',
  '                keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }',
  '                keyAlias = keystoreProperties.getProperty("keyAlias")',
  '                keyPassword = keystoreProperties.getProperty("password")',
  '                storeFile = file(keystoreProperties.getProperty("storeFile"))',
  '                storePassword = keystoreProperties.getProperty("password")',
  '            }',
  '        }',
  '    }',
  '',
].join('\n')

const buildTypesAnchor = '    buildTypes {'
if (!content.includes(buildTypesAnchor)) {
  console.error('[eizhu] 未找到 buildTypes 块，Gradle 模板可能已变更，请检查补丁脚本')
  process.exit(1)
}
content = content.replace(buildTypesAnchor, `${signingConfig}${buildTypesAnchor}`)

const debugAnchor = '        getByName("debug") {'
if (!content.includes(debugAnchor)) {
  console.error('[eizhu] 未找到 debug buildType，Gradle 模板可能已变更，请检查补丁脚本')
  process.exit(1)
}
content = content.replace(
  debugAnchor,
  [
    debugAnchor,
    '            signingConfig = if (rootProject.file("keystore.properties").exists())',
    '                signingConfigs.getByName("eizhu") else signingConfigs.getByName("debug")',
  ].join('\n'),
)

const releaseAnchor = '        getByName("release") {'
if (!content.includes(releaseAnchor)) {
  console.error('[eizhu] 未找到 release buildType，Gradle 模板可能已变更，请检查补丁脚本')
  process.exit(1)
}
content = content.replace(
  releaseAnchor,
  [
    releaseAnchor,
    '            if (rootProject.file("keystore.properties").exists())',
    '                signingConfig = signingConfigs.getByName("eizhu")',
  ].join('\n'),
)

writeFileSync(gradlePath, content)
console.log('[eizhu] 已为 debug/release 构建注入固定签名配置（keystore.properties 存在时生效）')
