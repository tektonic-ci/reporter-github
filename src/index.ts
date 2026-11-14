/**
 * GitHub Commit Status reporter for tektonic.
 *
 * Ships outside `@tektonic-ci/core` on purpose: it imports nothing but that package's
 * published surface, so the `StatusReporter` seam is exercised by a real out-of-tree
 * implementation rather than assumed to work. See `docs/status-reporters.md`.
 *
 * ```ts
 * import { GitHubStatusReporter } from '@tektonic-ci/reporter-github';
 *
 * const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true });
 * new Task({ name: 'test', statusReporter, steps: [...] });
 * ```
 */
export { GitHubStatusReporter, PIPELINE_RUN_PARAM, statusParam, tektonDashboardUrl } from "./github-status-reporter";
export type { GitHubStatusReporterOptions, StatusDetailsUrl } from "./github-status-reporter";
export {
  GitHubChecksReporter,
  CHECK_RUN_ID_PARAM,
  CHECK_RUN_ID_PATH,
  DEFAULT_ANNOTATION_PATTERN,
  MAX_CHECK_OUTPUT_BYTES,
  checkRunResultName,
} from "./github-checks-reporter";
export type { GitHubChecksReporterOptions } from "./github-checks-reporter";
