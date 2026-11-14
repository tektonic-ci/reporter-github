// Nushell fragments shared by the GitHub reporters. Internal: not exported from the package.

import type { StatusDetailsUrl } from './github-status-reporter';
import { PIPELINE_RUN_PARAM } from './github-status-reporter';

// A nushell double-quoted string literal. JSON's escapes (\" \\ \n \t) are valid there too,
// so a context containing a quote cannot end the literal early.
export function nuString(value: string): string {
  return JSON.stringify(value);
}

// 45s, 3m12s, 1h05m: GitHub truncates long descriptions, so seconds drop once a run passes an hour.
export const FORMAT_DURATION_DEF = `def format-duration [secs: int]: nothing -> string {
  let secs = ([$secs 0] | math max)
  let h = $secs // 3600
  let m = ($secs mod 3600) // 60
  let s = $secs mod 60
  let pad = { |n| $n | into string | fill -a right -w 2 -c '0' }
  if $h > 0 {
    $"($h)h(do $pad $m)m"
  } else if $m > 0 {
    $"($m)m(do $pad $s)s"
  } else {
    $"($s)s"
  }
}`;

// Every context has been tried by the time this runs; exit non-zero once if any failed, so the
// failure stays visible in the step's state.
export function failIfAny(label: string): string {
  return `if ($failed | is-not-empty) {
  log $"${label}: ($failed | length) failed: ($failed | str join ', ')"
  exit 1
}`;
}

/**
 * Fills a {@link StatusDetailsUrl} template with the Tekton variables a step resolves at run
 * time. The pending and reconcile tasks must use the `pipelineRun` template: the TaskRun
 * substituted there would be their own, not the task being reported on.
 */
export function detailsUrlExpr(detailsUrl: StatusDetailsUrl, kind: 'pipelineRun' | 'taskRun'): string {
  const template = kind === 'taskRun' ? detailsUrl.taskRun ?? detailsUrl.pipelineRun : detailsUrl.pipelineRun;
  return template
    .split('{namespace}').join('$(context.taskRun.namespace)')
    .split('{pipelineRun}').join(`$(params.${PIPELINE_RUN_PARAM})`)
    .split('{taskRun}').join('$(context.taskRun.name)');
}
