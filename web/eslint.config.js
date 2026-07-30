import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Dialog and connection state is intentionally synchronized from
      // external props and stores in effects throughout the app.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: [
      'src/components/ui/*.tsx',
      'src/components/Sftp/InputDialog.tsx',
      'src/lib/serverIcons.tsx',
    ],
    rules: {
      // shadcn components intentionally export variants/helpers alongside
      // components; InputDialog also exports its shared filename validator.
      'react-refresh/only-export-components': 'off',
    },
  },
])
