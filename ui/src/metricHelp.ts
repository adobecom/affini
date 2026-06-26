/**
 * Single source of truth for metric model explanations.
 * Each entry maps to a popover shown via <InfoTip>.
 * Formulas reference the Rust source where computed.
 */

export interface MetricHelp {
  label: string
  formula?: string
  body: string
}

export const METRIC_HELP: Record<string, MetricHelp> = {
  fan_in: {
    label: 'Fan-in',
    body:
      'The number of other modules that import this one. ' +
      'A high fan-in means many modules depend on this file — it is a widely-used dependency. ' +
      'Stable, low-level modules tend to have high fan-in.',
  },
  fan_out: {
    label: 'Fan-out',
    body:
      'The number of modules this file imports. ' +
      'A high fan-out means this file depends on many others — it is "wide" and harder to move or test in isolation.',
  },
  coupling: {
    label: 'Coupling',
    formula: 'fan_out / total_modules',
    body:
      'What fraction of all modules in the project does this file import? ' +
      'Shown as a percentage. High coupling (> 20–30%) often signals a utility or "god" module that knows too much about the rest of the codebase.',
  },
  instability: {
    label: 'Instability',
    formula: 'fan_out / (fan_in + fan_out)',
    body:
      "Robert Martin's instability metric. Ranges 0–1. " +
      '0 = maximally stable (depended on by many, depends on nothing). ' +
      '1 = maximally unstable (depends on many, depended on by none). ' +
      'Stable modules sit at the bottom of the architecture; unstable ones at the top. ' +
      'A violation occurs when a stable module imports an unstable one.',
  },
  loc: {
    label: 'Lines of code',
    body:
      'Raw source line count for this file (including blank lines and comments). ' +
      'Node width in the graph scales with LOC as a quick size signal.',
  },
  cycle: {
    label: 'Dependency cycle (SCC)',
    body:
      "Detected by Tarjan's Strongly Connected Components (SCC) algorithm. " +
      'Any group of modules with scc_size > 1 form a circular import — A imports B imports … imports A. ' +
      'Cycles prevent clean layer separation and make incremental compilation harder.',
  },
  hub: {
    label: 'Hub module',
    body:
      'A module whose fan-in is in the top 10% of the project (≥ 90th-percentile fan-in). ' +
      'Hubs are heavily depended-upon; changes to them have wide blast radius.',
  },
  orphan: {
    label: 'Orphan module',
    body:
      'A module with fan-in = 0 AND fan-out = 0 — nothing imports it and it imports nothing. ' +
      'Usually dead code or a standalone script.',
  },
  similarity: {
    label: 'Similarity score',
    formula: 'avg pairwise Jaccard(k-shingles)',
    body:
      'Structural similarity between files in a cluster, measured as the average pairwise ' +
      'Jaccard index of their k-shingle token-hash sets. ' +
      '1.0 = identical token structure; 0.6 is the default threshold for grouping. ' +
      'High similarity means files share most of the same code patterns and may be candidates for consolidation.',
  },
  violations: {
    label: 'Violations',
    body:
      'Breaches of rules declared in affini.toml under [intent]. Two kinds: ' +
      '(1) Forbidden edges — an explicit "module A must not import module B" rule. ' +
      '(2) Layer violations — a module in a more-stable architectural layer importing from a less-stable layer above it. ' +
      'Both are surfaced as Errors.',
  },
  fragility_metric: {
    label: 'Metric fragility flags (M)',
    body:
      'Structural risk detected at this call step. Three codes: ' +
      'scc_cycle (the call crosses a circular dependency), ' +
      'high_instability (target module instability > 0.75 — it depends on a lot but is depended on by few), ' +
      'violation (the call crosses an affini.toml-forbidden boundary).',
  },
  fragility_type: {
    label: 'Type fragility flags (T)',
    body:
      'Type-safety risk at this call step. Flags are raised when a parameter or return value ' +
      'is typed as any or unknown (any_payload / any_return), or has no type annotation at all ' +
      '(untyped_boundary). These boundaries let data of any shape pass through unchecked.',
  },
  fragility_churn: {
    label: 'Churn fragility flags (C)',
    body:
      'Change-velocity risk. Raised when the caller (churn_caller) or callee (churn_callee) ' +
      'module has been modified since the baseline snapshot. ' +
      'Frequent changes combined with structural fragility increase the likelihood of regressions.',
  },
  avg_fan_in: {
    label: 'Avg fan-in',
    body: 'Project-wide average fan-in (incoming imports per module) across this snapshot. Rising values mean modules are growing more interconnected.',
  },
  avg_fan_out: {
    label: 'Avg fan-out',
    body: 'Project-wide average fan-out (outgoing imports per module). A rising trend often accompanies increasing coupling.',
  },
  avg_coupling: {
    label: 'Avg coupling %',
    formula: 'mean(fan_out / total_modules) × 100',
    body: 'Mean coupling percentage across all modules in this snapshot. Tracks how tightly the codebase is woven together over time.',
  },
  violation_count: {
    label: 'Violations',
    body: 'Total number of architectural rule breaches (forbidden edges + layer order violations) in this snapshot. Should trend toward zero.',
  },
}
