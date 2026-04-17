module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Include only the Jest-based unit tests.
  // The suite/ directory contains Mocha integration tests run via `npm run test:integration`.
  testMatch: ['<rootDir>/src/test/*.test.ts', '<rootDir>/src/**/__tests__/**/*.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/test/suite/',  // Mocha tests — use `npm run test:integration`
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/test/__mocks__/vscode.ts',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/test/suite/**',
    '!src/test/runTest.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
}; 