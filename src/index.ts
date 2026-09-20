/**
 * GitHub Commit Status reporter for tektonic.
 *
 * Ships outside `@pfenerty/tektonic` on purpose: it imports nothing but that package's
 * published surface, so the `StatusReporter` seam is exercised by a real out-of-tree
 * implementation rather than assumed to work. See `docs/status-reporters.md`.
 *
 * ```ts
 * import { GitHubStatusReporter } from '@pfenerty/tektonic-reporter-github';
 *
 * const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true });
 * new Task({ name: 'test', statusReporter, steps: [...] });
 * ```
 */
export { GitHubStatusReporter, statusParam } from "./github-status-reporter";
export type { GitHubStatusReporterOptions } from "./github-status-reporter";
