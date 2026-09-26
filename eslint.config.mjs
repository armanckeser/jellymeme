import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescript from 'eslint-config-next/typescript'

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'data/**', 'renders/**'] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Route handlers and library code legitimately catch without binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
]

export default config
