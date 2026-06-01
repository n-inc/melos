import { createRoute } from '@n-inc/melos';

export default createRoute({
  run: {
    engine: 'codex',
    effort: 'medium',
  },
  limit: 6,
  workflow: {
    start: 'review',
    phases: {
      review: {
        task: [
          'Review the current diff as a maintainer.',
          'Prioritize correctness, security, public API compatibility, and missing tests.',
          'Fix straightforward issues directly and leave explicit notes for anything that needs human judgment.',
        ].join('\n'),
        validate: {
          shell: ['npm test', 'npm run typecheck', 'npm run lint'],
          llm: [
            'The final diff addresses the review findings that can be fixed safely.',
            'Any remaining concerns are listed in the final report.',
            'The package remains suitable for a public repository.',
          ],
        },
        on: {
          pass: 'stop',
          fail: { goto: 'review' },
        },
      },
    },
  },
});
