// Global test setup
// The `vscode` module is mocked via `moduleNameMapper` in jest.config.js,
// which points at src/test/__mocks__/vscode.ts.

beforeAll(() => {
  // Add any global setup here
});

// Global test teardown
afterAll(() => {
  // Add any global cleanup here
});

// Reset mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});
