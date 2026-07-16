import { defineRootCommand } from '@parshjs/core';

// Anchors the command tree; all behavior lives in the `gen` command.
export const command = defineRootCommand({
  options: {},
});
