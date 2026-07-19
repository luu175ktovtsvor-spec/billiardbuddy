import { describe, expect, it } from 'vitest'

import { SAFE_DOCTOR_STORAGE_KEYS, runLocalDoctorRepair, runDoctorRepair } from './doctorRepair'

describe('doctorRepair', () => {
  it('clears only the safe desktop UI storage keys', () => {
    window.localStorage.clear()
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      window.localStorage.setItem(key, `${key}-value`)
    }
    window.localStorage.setItem('billiardbuddy-chat-history', 'preserve')
    window.localStorage.setItem('billiardbuddy-provider-config', 'preserve')

    const result = runLocalDoctorRepair(window.localStorage)

    expect(result.removedKeys).toEqual(expect.arrayContaining([...SAFE_DOCTOR_STORAGE_KEYS]))
    expect(result.failedKeys).toEqual([])
    for (const key of SAFE_DOCTOR_STORAGE_KEYS) {
      expect(window.localStorage.getItem(key)).toBeNull()
    }
    expect(window.localStorage.getItem('billiardbuddy-chat-history')).toBe('preserve')
    expect(window.localStorage.getItem('billiardbuddy-provider-config')).toBe('preserve')
  })

  it('keeps local repair non-throwing when storage access is blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      },
    }

    const result = runLocalDoctorRepair(storage)

    expect(result.removedKeys).toEqual([])
    expect(result.failedKeys).toEqual(expect.arrayContaining([...SAFE_DOCTOR_STORAGE_KEYS]))
  })

  it('returns only the local repair result', async () => {
    window.localStorage.clear()
    window.localStorage.setItem('billiardbuddy-theme', 'dark')

    const result = await runDoctorRepair({ storage: window.localStorage })

    expect(result.removedKeys).toContain('billiardbuddy-theme')
    expect(result).not.toHaveProperty('server')
    expect(result).not.toHaveProperty('serverError')
  })
})
