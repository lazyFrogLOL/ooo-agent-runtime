import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../vitest.shared.ts'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const hostRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Run from an installed Harness workspace after copying this package into packages/experimental. */
export default defineConfig({
  root: hostRoot,
  resolve: {
    alias: [
      // Resolve package self-imports to this checkout, including in isolated host copies.
      { find: /^@deepseek-ai\/dsh-ooo-loop$/, replacement: `${packageRoot}src/index.ts` },
      { find: /^@deepseek-ai\/dsh-ooo-loop\/invariant$/, replacement: `${packageRoot}src/invariant.ts` },
      // The host testkit also imports AgentLoop. Keep it on the same module instance as local tests.
      { find: /^@deepseek-ai\/dsh-agent-loop$/, replacement: `${packageRoot}src/index.ts` },
      { find: /^@deepseek-ai\/dsh-agent-loop\/invariant$/, replacement: `${packageRoot}src/invariant.ts` },
      { find: '@deepseek-ai/dsh-llm-pi-ai/src/context.ts', replacement: `${hostRoot}packages/llm/llm-pi-ai/src/context.ts` },
    ],
  },
  plugins: [tsconfigPaths({ projects: [`${hostRoot}tsconfig.base.json`] }), standardDecoratorPlugin()],
  test: {
    pool: 'forks',
    execArgv: vitestExecArgv,
    setupFiles: [`${hostRoot}scripts/test-proxy-environment.ts`, `${hostRoot}scripts/test-invariants.ts`],
    include: [`${packageRoot}tests/**/*.spec.ts`],
  },
})
