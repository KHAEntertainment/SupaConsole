// Provisioning engine: everything that touches project files on disk or runs
// Docker. Callers (project.ts, route handlers) own the database; the engine
// takes typed arguments and runs processes only through argument arrays.
export { run, docker } from './run'
export type { RunOptions, RunResult } from './run'
export {
  OVERRIDE_FILE,
  REALTIME_ALIAS,
  renderOverride,
  renderLegacyOverride,
} from './override'
export type { OverrideProfile, RenderOverrideInput } from './override'
export {
  COMPOSE_FILE,
  PROJECT_META_FILE,
  resolveTarget,
  resolveLegacyProjectName,
  readProjectMeta,
  writeProjectMeta,
} from './layout'
export type { ComposeTarget, ProjectLayout, ProjectMeta } from './layout'
export { listServices, writeOverride, pull, up, stop, down, ps } from './compose'
export type { ServiceState } from './compose'
export { copyDockerTemplate, removeProjectDir } from './files'
export { checkDockerPrerequisites, checkInternetConnectivity } from './preflight'
