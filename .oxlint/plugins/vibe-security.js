import { definePlugin, defineRule } from "@oxlint/plugins";

// Flags `console.log(`cd '...'`)` shell output whose interpolated paths are not
// wrapped in escapeShellPath(). The visitor walks each CallExpression, narrows
// to console.log with a leading "cd '" template, then requires every `${...}`
// to be an escapeShellPath() call. Mirrors the former ESLint rule 1:1 — the
// oxlint plugin API is ESLint-compatible (create/context.report).
const noUnescapedCdOutput = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require escapeShellPath() in cd shell output to prevent injection",
    },
    messages: {
      unescaped: "Unescaped path in cd output. Use escapeShellPath() to prevent shell injection.",
    },
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
});

// Replaces the former ESLint `no-restricted-syntax` selectors for execSync.
// oxlint has no native `no-restricted-syntax`, so the two selectors
// (`execSync(...)` and `x.execSync(...)`) are expressed directly as a visitor:
// any CallExpression whose callee is the identifier `execSync` or a member
// `.execSync` is flagged in favour of spawn() with array arguments.
const noExecSync = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow execSync(); use spawn() with array arguments instead" },
    messages: { execSync: "Use spawn() with array arguments instead." },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const isBareExecSync = callee.type === "Identifier" && callee.name === "execSync";
        const isMemberExecSync =
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "execSync";
        if (isBareExecSync || isMemberExecSync) {
          context.report({ node, messageId: "execSync" });
        }
      },
    };
  },
});

// Replaces the former ESLint `no-restricted-syntax` selector
// `Property[key.name='shell'][value.value=true]`: a `shell: true` object
// property enables shell injection, so flag it directly.
const noShellTrue = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow `shell: true` which enables shell injection" },
    messages: { shellTrue: "shell: true enables shell injection." },
  },
  create(context) {
    return {
      Property(node) {
        const isShellKey =
          (node.key.type === "Identifier" && node.key.name === "shell") ||
          (node.key.type === "Literal" && node.key.value === "shell");
        const isTrueValue = node.value.type === "Literal" && node.value.value === true;
        if (isShellKey && isTrueValue) {
          context.report({ node, messageId: "shellTrue" });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "vibe-security" },
  rules: {
    "no-unescaped-cd-output": noUnescapedCdOutput,
    "no-execsync": noExecSync,
    "no-shell-true": noShellTrue,
  },
});
