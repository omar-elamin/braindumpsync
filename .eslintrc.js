module.exports = {
  extends: ["@raycast/eslint-config"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
  },
};