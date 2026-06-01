#!/usr/bin/env node

import { run } from './cli.js';

run().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
