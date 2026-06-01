import { createRoute } from '@n-inc/melos';

export default createRoute({
  run: {
    engine: 'auto',
  },
  limit: 4,
  workflow: {
    start: 'inspect',
    phases: {
      inspect: {
        task: [
          'Inspect package.json and README.md.',
          'Do not edit files.',
          'Summarize what this package does and which command would verify it.',
        ].join('\n'),
        validate: {
          shell: ['node --version'],
          llm: [
            'The response summarizes the package purpose.',
            'The response does not claim to have edited files.',
          ],
        },
        on: {
          pass: 'stop',
          fail: { goto: 'inspect' },
        },
      },
    },
  },
});
