const inWorktree = /[/\\]\.worktrees[/\\]/.test(process.cwd());

/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: inWorktree
    ? ['/node_modules/']
    : ['/node_modules/', '/\\.worktrees/'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
};
