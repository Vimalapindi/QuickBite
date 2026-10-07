module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
  setupFiles: ['<rootDir>/tests/setup/env.ts'],
  testTimeout: 30000,
  forceExit: true,
};
