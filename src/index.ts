#!/usr/bin/env node
/**
 * Melos CLI エントリーポイント
 *
 * @module index
 */

import { run } from './cli.js';

// CLI を実行
run().catch((error) => {
  console.error('予期しないエラー:', error);
  process.exit(1);
});
