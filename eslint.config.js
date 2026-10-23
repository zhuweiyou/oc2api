import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import globals from "globals"

export default [
  {
    ignores: ["node_modules/", ".vercel/", ".git/", "dist/", "worker/dist/"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  prettier,
]
