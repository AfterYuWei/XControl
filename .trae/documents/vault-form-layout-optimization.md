# Vault 表单布局优化计划

## 概述

将 Vault 新增凭据表单从左右分栏布局改为上下两层布局，解决左右高度不一致问题，提升视觉稳定性。

## 当前状态分析

### 现有布局结构

**文件**: `web/src/components/Vault/VaultFormDialog.tsx`

当前布局使用左右分栏：

* `.vault-sheet-body` 使用 `grid-template-columns: minmax(208px, 224px) minmax(0, 1fr)`

* 左侧 `.vault-sheet-rail`: 类型标签、名称、类型选择、用户名、备注、RailSummary

* 右侧 `.vault-sheet-main`: 根据类型显示 PasswordEditorSection 或私钥相关字段

**问题**:

1. 切换类型时左右两侧高度变化不一致，视觉跳动
2. RailSummary 与凭据详情区域重复展示信息
3. 窄屏时需要滚动，左右布局体验不佳

### 相关样式文件

**文件**: `web/src/styles/vault.css`

关键类：

* `.vault-sheet-body`: 主布局容器，左右分栏

* `.vault-sheet-rail`: 左侧栏

* `.vault-sheet-main`: 右侧栏

* `.vault-sheet-grid`: 右侧内部网格布局

* `.vault-form-layout`: 表单布局辅助类

* `.vault-form-rail-panel`: 左侧面板样式

* `.vault-form-password-primary`: 密码编辑区样式

## 方案设计

### 新布局结构

```
+-------------------------------------------------------------------------+
| 新建凭据                                                              X |
+-------------------------------------------------------------------------+
|                                                                         |
|  [基本信息区域 - 固定不动]                                              |
|  名称                        类型                用户名                  |
|  [ prod-root-key          ]  [ 密码        v ]  [ root               ]  |
|                                                                         |
|  备注 (可选)                                                             |
|  [ 请输入备注...                                                     ]  |
|                                                                         |
+-------------------------------------------------------------------------+
|                                                                         |
|  [凭据详情区域 - 随类型变化]                                            |
|                                                                         |
|  密码类型:                                                              |
|  | 密码                                            [ 🎲 生成 ]          |
|  | [ ********************************** ]                              |
|  | 💡 建议搭配用户名或备注一起保存。推荐长度 16-24 位。                  |
|                                                                         |
|  私钥类型:                                                              |
|  | 私钥                                            [ 💾 导入 ]          |
|  | +---------------------------------------------------------------+   |
|  | | -----BEGIN OPENSSH PRIVATE KEY-----                           |   |
|  | +---------------------------------------------------------------+   |
|  | 公钥 (可选)                                         [ 💾 导入 ]  |   |
|  | [ ssh-ed25519 AAAA...                                         ]  |   |
|  | Passphrase (可选)                              |   |
|  | [ 请输入密码短语...                                           ]  |   |
|                                                                         |
+-------------------------------------------------------------------------+
|                                                       [ 取消 ] [ 创建 ] |
+-------------------------------------------------------------------------+
```

### 设计决策

1. **移除 RailSummary 组件**: 信息与凭据详情区域重复，简化后信息统一在详情区提示
2. **移除类型标签 Chip**: 上层已显示类型选择器，无需重复
3. **统一提示文案**: 密码类型保留底部提示，私钥类型保持现有布局
4. **分隔线样式**: 使用 `border-top` 配合 `margin` 实现视觉分隔

## 实现步骤

### 1. 修改 VaultFormDialog.tsx 组件结构

**变更内容**:

* 移除 `<aside className="vault-sheet-rail">` 左侧栏

* 将基本信息字段（名称、类型、用户名、备注）移到上层

* 凭据详情区域保持现有逻辑，放在下层

* 移除 `RailSummary` 组件调用

* 移除类型标签 Chip 展示

**新 JSX 结构**:

```tsx
<form className="vault-form vault-sheet-form">
  {/* 基本信息 */}
  <section className="vault-form-basic">
    <div className="vault-form-basic-grid">
      <div className="pf-field">名称...</div>
      <div className="pf-field">类型...</div>
      <div className="pf-field">用户名...</div>
      <div className="pf-field vault-form-remark">备注...</div>
    </div>
  </section>

  {/* 分隔线 */}
  <div className="vault-form-divider" />

  {/* 凭据详情 */}
  <div className="vault-form-credential">
    {form.type === 'password' ? (
      <PasswordEditorSection ... />
    ) : (
      <>
        <section>公钥...</section>
        <section>Passphrase...</section>
        <UploadTextareaField label="私钥" ... />
      </>
    )}
  </div>

  {/* 底部按钮 */}
  <div className="vault-sheet-footer">...</div>
</form>
```

### 2. 更新 vault.css 样式

**新增样式**:

```css
/* 基本信息 - 上层 */
.vault-form-basic {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--dialog-bg) 97%, var(--bg-elevated));
  box-shadow: var(--shadow-surface);
}

.vault-form-basic-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 12px;
}

.vault-form-remark {
  grid-column: 1 / -1;
}

/* 分隔线 */
.vault-form-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

/* 凭据详情 - 下层 */
.vault-form-credential {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
```

**移除/调整样式**:

* `.vault-sheet-rail` 相关样式（保留用于详情弹窗）

* `.vault-form-rail-panel`

* `.vault-form-rail-summary` 系列

* `.vault-form-layout` 改为单列布局

* `.vault-sheet-body` 改为单列 flex 布局

### 3. 简化 PasswordEditorSection

* 移除重复的上下文信息展示（用户名/备注）

* 保留密码输入、生成器、底部提示

* 调整布局适应单列

### 4. 响应式适配

```css
@media (max-width: 720px) {
  .vault-form-basic-grid {
    grid-template-columns: 1fr;
  }

  .vault-form-remark {
    grid-column: auto;
  }
}
```

## 文件变更清单

| 文件                                             | 变更类型 | 说明                    |
| ---------------------------------------------- | ---- | --------------------- |
| `web/src/components/Vault/VaultFormDialog.tsx` | 重构   | 重构布局结构，移除 RailSummary |
| `web/src/styles/vault.css`                     | 修改   | 新增上层样式，调整布局样式         |

## 验证步骤

1. 打开新建凭据弹窗，验证基本信息区域布局正确
2. 切换类型（密码/私钥），验证上半部分固定不动
3. 测试密码生成器展开/收起功能
4. 测试私钥导入功能
5. 验证响应式布局（窄屏适配）
6. 测试编辑现有凭据场景
7. 验证表单提交、错误提示功能正常

## 风险与注意事项

1. 编辑模式下类型选择器禁用，需保持现有逻辑
2. 确保表单验证逻辑不受影响
3. 注意保持与 VaultDetailDialog 样式一致性

