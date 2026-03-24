import configPrettier from "@electron-toolkit/eslint-config-prettier"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const toolkitRequire = createRequire(require.resolve("@electron-toolkit/eslint-config-ts"))
const tsParser = toolkitRequire("@typescript-eslint/parser")
const tsPlugin = toolkitRequire("@typescript-eslint/eslint-plugin")

const tsEslintRecommended =
  tsPlugin.configs["eslint-recommended"]?.overrides?.[0]?.rules ?? {}
const tsRecommended = tsPlugin.configs.recommended?.rules ?? {}

export default [
  {
    ignores: [
      "node_modules/**",
      "out/**",
      "dist/**",
      "build/**",
      "resources/**",
      ".idea/**",
      ".vscode/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsEslintRecommended,
      ...tsRecommended,
      "unicode-bom": ["error", "never"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-undef": "off",
    },
  },
  configPrettier,
]
