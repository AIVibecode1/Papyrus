// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/target/**", "node_modules/**", ".venv/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true } },
  },
  {
    // dev/ scripts run under Node; capture-screenshots also drives a browser.
    files: ["dev/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  prettier, // disables style rules prettier owns
);
