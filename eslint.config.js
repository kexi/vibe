import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginSecurity from "eslint-plugin-security";

/** @type {import('eslint').ESLint.Plugin} */
const vibeSecurityPlugin = {
  meta: { name: "vibe-security" },
  rules: {
    "no-unescaped-cd-output": {
      meta: {
        type: "problem",
        docs: {
          description: "Require escapeShellPath() in cd shell output to prevent injection",
        },
        messages: {
          unescaped:
            "Unescaped path in cd output. Use escapeShellPath() to prevent shell injection.",
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            // Match console.log(...)
            const isConsoleLog =
              node.callee.type === "MemberExpression" &&
              node.callee.object.type === "Identifier" &&
              node.callee.object.name === "console" &&
              node.callee.property.type === "Identifier" &&
              node.callee.property.name === "log";
            if (!isConsoleLog) return;

            const arg = node.arguments[0];
            const isTemplateLiteral = arg && arg.type === "TemplateLiteral";
            if (!isTemplateLiteral) return;

            // Check if template starts with "cd '"
            const firstQuasi = arg.quasis[0];
            const startsWith_cd = firstQuasi.value.raw.startsWith("cd '");
            if (!startsWith_cd) return;

            // Each expression in the template must be escapeShellPath(...)
            for (const expr of arg.expressions) {
              const isEscaped =
                expr.type === "CallExpression" &&
                expr.callee.type === "Identifier" &&
                expr.callee.name === "escapeShellPath";
              if (!isEscaped) {
                context.report({ node: expr, messageId: "unescaped" });
              }
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginSecurity.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "packages/core/src/version.ts",
      "packages/docs/**",
      "packages/video/**",
      "packages/npm/**",
      "packages/native/**",
      "packages/e2e/**",
    ],
  },
  {
    plugins: {
      "vibe-security": vibeSecurityPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "child_process",
              message: "Use the runtime abstraction layer instead.",
            },
            {
              name: "node:child_process",
              message: "Use the runtime abstraction layer instead.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='execSync']",
          message: "Use spawn() with array arguments instead.",
        },
        {
          selector: "CallExpression[callee.property.name='execSync']",
          message: "Use spawn() with array arguments instead.",
        },
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: "shell: true enables shell injection.",
        },
      ],
      "security/detect-eval-with-expression": "error",
      "security/detect-child-process": "off",
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-unsafe-regex": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-object-injection": "off",
      "security/detect-possible-timing-attacks": "warn",
      "vibe-security/no-unescaped-cd-output": "error",
    },
  },
  {
    files: ["packages/core/src/runtime/node/process.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
    },
  },
);
