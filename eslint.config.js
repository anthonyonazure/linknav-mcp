import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  // Leading **/ matters: "dist/**" only ever matched a dist folder at the repo
  // root, so a nested build output (packages/*/dist, ticker/dist) was linted as
  // if it were source and buried the real findings under hundreds of errors
  // about generated code.
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/*.cjs"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Config files (eslint.config.js, *.config.ts) live outside tsconfig's
    // "include", so the project service cannot type them and reports a parsing
    // error rather than a real finding. allowDefaultProject lints them with an
    // inferred default program instead of failing the gate on a config quirk.
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.mjs", "*.cjs", "*.ts", "*.config.js", "*.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
