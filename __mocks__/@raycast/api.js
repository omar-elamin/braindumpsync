// Manual mock for @raycast/api
module.exports = {
  environment: {
    supportPath: "/tmp/test-raycast-support",
    commandName: "test-command"
  },
  getPreferenceValues: jest.fn(() => ({
    inboxDir: "~/test-inbox",
    openaiKey: "test-openai-key",
    openaiModel: "gpt-4o",
    notionToken: "test-notion-token",
    notionDbId: "test-notion-db-id",
    enableScheduled: true
  })),
  LaunchProps: {},
  clearSearchBar: jest.fn(),
  showToast: jest.fn(),
  Toast: {
    Style: {
      Success: "success",
      Failure: "failure"
    }
  },
  showHUD: jest.fn()
};
