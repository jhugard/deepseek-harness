/** Launcher-owned profile locations and composition inputs. */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** Application-owned package manager executable; environment applies only to package operations. */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** Current profile facts; scheduling and mutation belong to their callers. */
export interface ProfileContext {
  readonly name: string
  /** Packaged applications supply their bundled runtime instead of a PATH executable. */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  /** Parsed command-line overlays, applied above profile and home patches. */
  readonly overlays: readonly PatchOptions[]
  /** Launch-time DSH_TELEMETRY_DISABLED value; any non-empty value opts out. */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileContext: ProfileContext
  }
}

/** Rows that own a network path out of the process; the opt-out switch disables every one present.
 * The Desktop analytics sender names `productTelemetry` as a required inject, so its uploader row
 * (`desktop-product-telemetry`) and the sender disable together, as in the bundle patch. */
const TELEMETRY_ROW_IDS = ['session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics'] as const

/**
 * Resolve the telemetry opt-out switch into its boot patches. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without a telemetry row
 * exports nothing through it, so the switch is trivially satisfied for that row
 * and no patch is generated — custom profiles need not mount telemetry to run
 * with the switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param composed - row ids present in the composed composition.
 * @returns one disable patch per present row, empty when no hard-disable patch is required.
 */
export function resolveTelemetryPatches(disabledEnv: string | undefined, composed: readonly string[]): PatchOptions[] {
  if ((disabledEnv ?? '') === '') return []
  return TELEMETRY_ROW_IDS.filter(id => composed.includes(id)).map(id => ({ id, disabled: true }))
}

/** Read the selected bundles' patches, which apply before the profile patch file.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Bundle patches in application order.
 */
export function readBundlePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  return profile.layers.flatMap(layer => layer.patches)
}

/** Read current bundle and user layers with the launch-time overlays.
 * @param binName Diagnostic prefix for malformed or missing configuration.
 * @param context Data supplied by the profile launcher.
 * @param initialProfile Already loaded startup profile; omitted reads the current files.
 * @returns Detached ordered patches; this function does not update the Loader.
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const patches = structuredClone([
    ...readBundlePatches(binName, context, initialProfile),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  const telemetryPatches = resolveTelemetryPatches(context.telemetryDisabledEnv,
    composeEntries([patches]).map(row => row.id))
  patches.push(...telemetryPatches)
  return patches
}
