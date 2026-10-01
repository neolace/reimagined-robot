/** Runs against a deployed dev stack. See docs/operations/testing-strategy.md#integration-tests */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.int.test.ts'],
  transform: { '^.+\.tsx?$': 'ts-jest' },
  testTimeout: 15 * 60 * 1000,
};
