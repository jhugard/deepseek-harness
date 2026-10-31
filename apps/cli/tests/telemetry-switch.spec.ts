import { describe, expect, it } from 'vitest'
import { resolveTelemetryPatches } from '@deepseek-ai/dsh-app-boot'

const SESSION_ROW = 'session-telemetry-otel'
const PRODUCT_ROW = 'desktop-product-telemetry'

describe('resolveTelemetryPatches', () => {
  it('preserves the configured telemetry mode when the hard-disable switch is unset or empty', () => {
    expect(resolveTelemetryPatches(undefined, [SESSION_ROW, PRODUCT_ROW])).toEqual([])
    expect(resolveTelemetryPatches('', [SESSION_ROW, PRODUCT_ROW])).toEqual([])
  })

  it('disables on ANY non-empty value, including falsy-looking ones', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatches(value, [SESSION_ROW, PRODUCT_ROW])).toEqual([
        { id: SESSION_ROW, disabled: true },
        { id: PRODUCT_ROW, disabled: true },
      ])
    }
  })

  it('is trivially satisfied by a composition without the telemetry rows', () => {
    // A custom profile need not mount telemetry: nothing exports, so the
    // privacy switch has nothing to disable and generates no patch.
    expect(resolveTelemetryPatches('1', [])).toEqual([])
    expect(resolveTelemetryPatches(undefined, [])).toEqual([])
  })

  it('covers each uploader independently', () => {
    expect(resolveTelemetryPatches('1', [PRODUCT_ROW])).toEqual([{ id: PRODUCT_ROW, disabled: true }])
    expect(resolveTelemetryPatches('1', [SESSION_ROW])).toEqual([{ id: SESSION_ROW, disabled: true }])
  })
})
