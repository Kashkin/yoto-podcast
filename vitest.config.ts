import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Keeps worktrees under .claude/worktrees out of a run on main
    dir: 'tests',
  },
});
