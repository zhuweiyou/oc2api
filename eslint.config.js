import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import globals from "globals"

export default [
  {
    ignores: ["node_modules/", ".vercel/", ".git/", "dist/"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  prettier,
]
