/**
 * ACL failure-path tests with minimal stub binding tables: every checked
 * Win32 call in the lock, read-merge-write, mandatory-label, and
 * grant-skip sequence has a failing counterpart, and each failure closes the
 * handles it created before throwing. The exact-ACE/exact-label skip and the
 * DACL/SACL-walk defenses are driven through crafted in-memory ACL/SID
 * buffers. Pure stubs — no real Win32 calls, so these run on every platform;
 * the real-FFI round-trip lives in acl.spec.ts (win32 only).
 */

import { tmpdir } from 'node:os'
import { Win32Error } from '@deepseek-ai/dsh-win32-process'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import koffi from 'koffi'

import { ensureRelabelPrivilege, grantWrite, revokeWrite, withPathLock } from '../src/acl.ts'
import { allocBytes, ptrAddress } from '../src/ffi.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')

/** The stub the grant/revoke happy path needs; every call succeeds until a field is overridden per test. */
function aclApi(overrides: Partial<Win32Bindings> = {}): Win32Bindings {
  return {
    getTempPathW: vi.fn((_length: number, buffer: Buffer) => {
      const temp = tmpdir().replace(/[\\/]$/u, '')
      buffer.write(temp, 'utf16le')
      return temp.length
    }),
    createFileW: vi.fn(() => 7n),
    lockFileEx: vi.fn(() => 1),
    unlockFileEx: vi.fn(() => 1),
    closeHandle: vi.fn(() => 1),
    getNamedSecurityInfoW: vi.fn((
      _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
      dacl: NativePtr, sacl: NativePtr, descriptor: NativePtr,
    ) => {
      koffi.encode(dacl, PVOID, 0n) // no explicit DACL: the merge builds one
      koffi.encode(sacl, PVOID, 0n) // no mandatory label either
      koffi.encode(descriptor, PVOID, 0n)
      return 0
    }),
    setEntriesInAclW: vi.fn((_count: unknown, _entries: unknown, _old: unknown, newAcl: NativePtr) => {
      koffi.encode(newAcl, PVOID, 9n)
      return 0
    }),
    setNamedSecurityInfoW: vi.fn(() => 0),
    openProcess: vi.fn(() => 13n),
    openProcessToken: vi.fn((_process: unknown, _access: unknown, slot: NativePtr) => {
      koffi.encode(slot, PVOID, 14n)
      return 1
    }),
    getTokenInformation: vi.fn((_token: unknown, _cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
      if (info === null) {
        koffi.encode(needed, 'uint32', 8)
        return 0 // the TokenPrivileges size probe is expected to "fail"
      }
      info.writeUInt32LE(1, 0) // PrivilegeCount
      return 1
    }),
    lookupPrivilegeValueW: vi.fn((_system: unknown, _name: unknown, luid: Buffer) => {
      luid.writeUInt32LE(0x00010000, 0) // Luid.Low — the value is irrelevant to the stub
      luid.writeUInt32LE(0, 4) // Luid.High
      return 1
    }),
    adjustTokenPrivileges: vi.fn(() => 1),
    localAlloc: vi.fn(() => 11n),
    getLengthSid: vi.fn(() => 12),
    initializeAcl: vi.fn(() => 1),
    addMandatoryAce: vi.fn(() => 1),
    localFree: vi.fn(() => 0n as NativePtr),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  } as Win32Bindings
}

/** One SID allocation: revision@0, subAuthorityCount@1, identifierAuthority@2 (6 bytes), subauthorities@8. */
function craftSid(revision: number, count: number, authority: number[] = [0, 0, 0, 0, 0, 5]): NativePtr {
  const sid = allocBytes(8)
  koffi.encode(sid, 'uint8', revision)
  koffi.encode(sid, 1, 'uint8', count)
  authority.forEach((byte, index) => {
    koffi.encode(sid, 2 + index, 'uint8', byte)
  })
  return sid
}

/** The Low integrity SID both the token and the directory labels name. */
function craftLowLabelSid(): NativePtr {
  return craftSid(1, 0, [0, 0, 0, 0, 0, 16])
}

/** The world SID the grant's ambient-delete deny names (crafted like the other stubs: 8 header bytes, no sub-authorities). */
function craftWorldSid(): NativePtr {
  return craftSid(1, 0, [0, 0, 0, 0, 0, 1])
}

/** Write one 16-byte ACE (AceType@0, AceFlags@1, AceSize@2, Mask@4, inline SID@8) at `offset`. */
function writeAce(
  acl: NativePtr,
  offset: number,
  aceType: number,
  mask: number,
  sid: NativePtr,
  match: boolean,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): void {
  koffi.encode(acl, offset + 0, 'uint8', aceType)
  koffi.encode(acl, offset + 1, 'uint8', inheritance)
  koffi.encode(acl, offset + 2, 'uint16', 16)
  koffi.encode(acl, offset + 4, 'uint32', mask)
  for (let byte = 0; byte < 8; byte++) {
    koffi.encode(acl, offset + 8 + byte, 'uint8', match
      ? koffi.decode(sid, byte, 'uint8') as number
      : byte === 0 ? 9 : 0)
  }
}

/**
 * One in-memory ACL carrying a single inheritable ACE: header (AclRevision@0,
 * AclSize@2, AceCount@4) then a 16-byte ACE. `match` selects whether the
 * inline SID bytes equal `sid`.
 */
function craftAcl(aceType: number, mask: number, sid: NativePtr, match: boolean): NativePtr {
  const acl = allocBytes(32)
  koffi.encode(acl, 'uint8', 2) // AclRevision
  koffi.encode(acl, 2, 'uint16', 24)
  koffi.encode(acl, 4, 'uint16', 1)
  writeAce(acl, 8, aceType, mask, sid, match)
  return acl
}

/**
 * A two-ACE DACL: the ambient-delete deny plus the capability grant, each with
 * caller-chosen type, mask, and trustee match so the skip's field checks can be
 * driven one at a time.
 */
function craftPair(
  grantSid: NativePtr,
  world: NativePtr,
  denyType: number,
  denyMask: number,
  denyMatches: boolean,
  grantMatches: boolean,
): NativePtr {
  const acl = allocBytes(64)
  koffi.encode(acl, 'uint8', 2)
  koffi.encode(acl, 2, 'uint16', 40)
  koffi.encode(acl, 4, 'uint16', 2)
  writeAce(acl, 8, denyType, denyMask, world, denyMatches, abi.CONTAINER_INHERIT_ACE)
  writeAce(acl, 24, abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, grantSid, grantMatches)
  return acl
}

/**
 * The DACL a fully granted directory carries: the ambient-delete deny for the
 * world SID plus the capability grant. `grantMatches` selects whether the
 * grant's inline SID equals `sid` (the deny always matches), and
 * `includeDeny` drops the deny to model a root granted by an earlier build.
 */
function craftGrantedAcl(sid: NativePtr, world: NativePtr, grantMatches: boolean, includeDeny = true): NativePtr {
  if (!includeDeny) {
    const acl = allocBytes(64)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 24)
    koffi.encode(acl, 4, 'uint16', 1)
    writeAce(acl, 8, abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, grantMatches)
    return acl
  }
  return craftPair(sid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, true, grantMatches)
}

/** The label ACL the exact-label skip looks for: the Low no-write-up label ACE. */
function craftAclWithLabel(sid: NativePtr, match: boolean): NativePtr {
  return craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, sid, match)
}

/** Encode a security-info read whose DACL and label ACL are the given pointers. */
function readStub(dacl: NativePtr | null, label: NativePtr | null, descriptor: bigint | null) {
  return vi.fn((
    _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
    daclSlot: NativePtr, saclSlot: NativePtr, descriptorSlot: NativePtr,
  ) => {
    koffi.encode(daclSlot, PVOID, dacl === null ? 0n : ptrAddress(dacl))
    koffi.encode(saclSlot, PVOID, label === null ? 0n : ptrAddress(label))
    koffi.encode(descriptorSlot, PVOID, descriptor ?? 0n)
    return 0
  })
}

function requireApplyCall(
  setNamedSecurityInfoW: Mock<Win32Bindings['setNamedSecurityInfoW']>,
  index: number,
): Parameters<Win32Bindings['setNamedSecurityInfoW']> {
  const call = setNamedSecurityInfoW.mock.calls.at(index)
  expect(call).toBeDefined()
  if (call === undefined) {
    throw new Error(`Expected SetNamedSecurityInfoW call ${index + 1}`)
  }
  return call
}

describe('withPathLock failure paths', () => {
  it('fails closed when CreateFileW returns an invalid handle', () => {
    const api = aclApi({ createFileW: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      withPathLock(api, 'C:\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CreateFileW')
  })

  it('closes the handle and reports when LockFileEx fails', () => {
    const closeHandle = vi.fn(() => 1)
    const api = aclApi({ lockFileEx: vi.fn(() => 0), closeHandle })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LockFileEx')
    expect(closeHandle).toHaveBeenCalledWith(7n)
  })

  it('closes the handle and reports when UnlockFileEx fails', () => {
    const closeHandle = vi.fn(() => 1)
    const api = aclApi({ unlockFileEx: vi.fn(() => 0), closeHandle })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('UnlockFileEx')
    expect(closeHandle).toHaveBeenCalledWith(7n)
  })

  it('reports a failed CloseHandle after a successful action', () => {
    const api = aclApi({ closeHandle: vi.fn(() => 0) })
    let caught: unknown
    try {
      withPathLock(api, 'C:\\locked', () => {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('CloseHandle')
  })
})

describe('buildLowLabelAcl failure paths', () => {
  it('reports a failed GetLengthSid for the Low label SID', () => {
    const api = aclApi({ getLengthSid: vi.fn(() => 0) })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('GetLengthSid')
  })

  it('reports a failed LocalAlloc for the label ACL', () => {
    const api = aclApi({ localAlloc: vi.fn(() => 0n as NativePtr) })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalAlloc')
  })

  it('frees the label ACL and reports when InitializeAcl fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ initializeAcl: vi.fn(() => 0), localFree })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('InitializeAcl')
    expect(localFree).toHaveBeenCalledWith(11n)
  })

  it('frees the label ACL and reports when AddMandatoryAce fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ addMandatoryAce: vi.fn(() => 0), localFree })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('AddMandatoryAce')
    expect(localFree).toHaveBeenCalledWith(11n)
  })
})

describe('mergeAndApply failure paths', () => {
  it('reports a SetEntriesInAclW failure when the directory carries no descriptor to free', () => {
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 5) }) // default descriptor: none
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
  })

  it('reports a NULL merged ACL when there is no descriptor to free', () => {
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 0) }) // no out slot write, no descriptor
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
  })

  it('frees the descriptor and reports when SetEntriesInAclW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n), // an existing descriptor without a DACL
      setEntriesInAclW: vi.fn(() => 5),
      localFree,
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor and reports a NULL merged ACL', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      setEntriesInAclW: vi.fn(() => 0), // success without writing the out slot
      localFree,
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the merged ACL and the label ACL and reports when SetNamedSecurityInfoW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ setNamedSecurityInfoW: vi.fn(() => 5), localFree })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetNamedSecurityInfoW')
    expect(localFree).toHaveBeenCalledWith(9n) // merged DACL
    expect(localFree).toHaveBeenCalledWith(11n) // label ACL
  })

  it('reports a failed descriptor LocalFree after a successful apply', () => {
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      localFree: vi.fn(() => 1n as NativePtr), // both frees "fail"; the first is checked
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })

  it('reports a failed merged-ACL LocalFree after a successful apply', () => {
    // No existing descriptor (the default stub): the merge's only LocalFree
    // is the merged ACL's, which "fails" and is checked after the apply.
    const api = aclApi({ localFree: vi.fn(() => 1n as NativePtr) })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })

  it('reports a failed label-ACL LocalFree after a successful apply', () => {
    // Every free succeeds until the label ACL's: descriptor and merged ACL
    // return null, the label ACL returns a stale pointer.
    const localFree = vi.fn()
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValue(1n)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      localFree,
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
    expect(localFree).toHaveBeenLastCalledWith(11n)
  })

  it('frees the label ACL when SetEntriesInAclW fails during a revoke', () => {
    // The revoke carries no label ACL of its own: the early exit must still
    // release the descriptor and leave the label edit untouched.
    const localFree = vi.fn(() => 0n as NativePtr)
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      setEntriesInAclW: vi.fn(() => 5),
      localFree,
    })
    let caught: unknown
    try {
      revokeWrite(api, 'C:\\granted', sid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor on the null-merged-ACL path during a revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const sid = craftSid(1, 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true), null, 6n),
      setEntriesInAclW: vi.fn(() => 0), // success without writing the out slot
      localFree,
    })
    let caught: unknown
    try {
      revokeWrite(api, 'C:\\granted', sid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('frees the descriptor when the label ACL build fails', () => {
    // The read already owns a descriptor allocation; the label failure must
    // not strand it.
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      initializeAcl: vi.fn(() => 0),
      localFree,
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('InitializeAcl')
    expect(localFree).toHaveBeenCalledWith(11n) // the half-built label ACL
    expect(localFree).toHaveBeenCalledWith(6n) // the read descriptor
  })

  it('frees the label ACL when SetEntriesInAclW fails', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({ setEntriesInAclW: vi.fn(() => 5), localFree })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(11n) // the label ACL this apply owns
  })

  it('frees the label ACL and the descriptor on the null-merged-ACL path', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      setEntriesInAclW: vi.fn(() => 0), // success without writing the out slot
      localFree,
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetEntriesInAclW')
    expect(localFree).toHaveBeenCalledWith(6n)
    expect(localFree).toHaveBeenCalledWith(11n)
  })
})

describe('revokeWrite label handling', () => {
  /** The SECURITY_INFORMATION and SACL of the last apply. */
  function applyArgs(setNamedSecurityInfoW: Mock<Win32Bindings['setNamedSecurityInfoW']>): { information: number; sacl: unknown } {
    const call = setNamedSecurityInfoW.mock.calls.at(-1)
    return { information: call?.[2] as number, sacl: call?.[6] }
  }

  it('keeps the shared Low label while another capability grant stands', () => {
    const sid = craftSid(1, 0)
    const otherSid = craftSid(1, 0, [0, 0, 0, 0, 0, 6])
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      // The directory carries the deny plus a grant for a DIFFERENT SID.
      getNamedSecurityInfoW: readStub(
        craftPair(otherSid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, true, true), null, 6n,
      ),
      setNamedSecurityInfoW,
    })
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(true)
    const { information, sacl } = applyArgs(setNamedSecurityInfoW)
    expect(information & abi.LABEL_SECURITY_INFORMATION).toBe(0) // the label was left untouched
    expect(sacl).toBeNull()
  })

  it('clears the Low label once the last capability grant is revoked', () => {
    const sid = craftSid(1, 0)
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), null, 6n),
      setNamedSecurityInfoW,
    })
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
  })

  it('clears the Low label when a malformed tiny DACL hides any foreign grant', () => {
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 4) // smaller than the ACL header
    koffi.encode(acl, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
  })

  it('clears the Low label when a lying ACE size hides any foreign grant', () => {
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 8)
    koffi.encode(acl, 4, 'uint16', 1)
    koffi.encode(acl, 10, 'uint16', 100)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({ getNamedSecurityInfoW: readStub(acl, null, 6n), setNamedSecurityInfoW })
    expect(revokeWrite(api, 'C:\\granted', craftSid(1, 0))).toBe(true)
    expect(applyArgs(setNamedSecurityInfoW).information & abi.LABEL_SECURITY_INFORMATION).toBe(abi.LABEL_SECURITY_INFORMATION)
  })
})

describe('the exact-ACE/exact-label skip and ACL-walk defenses', () => {
  it('grantWrite skips the apply when the standing exact ACE and the exact label match (descriptor freed, nothing merged)', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const localFree = vi.fn(() => 0n as NativePtr)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, true), 6n),
      localFree,
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('grantWrite skips the apply without freeing when the exact ACE and label stand but no descriptor owns them', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const localFree = vi.fn(() => 0n as NativePtr)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      // the read "returned" ACLs with no descriptor allocation of their own
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, true), null),
      localFree,
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).not.toHaveBeenCalled()
    expect(localFree).not.toHaveBeenCalled()
  })

  it('grantWrite reports a failed descriptor LocalFree on the exact-ACE/exact-label skip path', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, true), 6n),
      localFree: vi.fn(() => 1n as NativePtr),
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })

  it('does not skip when a root granted by an earlier build carries the ACE and label but no ambient-delete deny', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true, false), craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not skip when the deny names another trustee', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftPair(sid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.FILE_DELETE_CHILD, false, true), craftAclWithLabel(lowSid, true), 6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not treat a deny of another right as the ambient-delete deny', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftPair(sid, world, abi.ACCESS_DENIED_ACE_TYPE, abi.GRANT_MASK, true, true), craftAclWithLabel(lowSid, true), 6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not treat an Allow ACE as the ambient-delete deny', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftPair(sid, world, abi.ACCESS_ALLOWED_ACE_TYPE, abi.FILE_DELETE_CHILD, true, true), craftAclWithLabel(lowSid, true), 6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not skip when the standing ACE and label match but the label ACL is absent', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), null, 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not skip when the exact ACE stands but the label names another integrity level', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), craftAclWithLabel(lowSid, false), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('falls back to the merge path when the standing ACE names a different SID', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, false), craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('treats an implausibly small ACL size as no exact grant', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 4) // smaller than the 8-byte ACL header
    koffi.encode(acl, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(acl, craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('treats an ACE that would overrun the ACL as no exact grant', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const acl = allocBytes(32)
    koffi.encode(acl, 'uint8', 2)
    koffi.encode(acl, 2, 'uint16', 8) // header only: no room for any ACE
    koffi.encode(acl, 4, 'uint16', 1)
    koffi.encode(acl, 10, 'uint16', 100) // the walk reads a lying ACE size
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(acl, craftAclWithLabel(lowSid, true), 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('treats an implausibly small label ACL size as no exact label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const label = allocBytes(32)
    koffi.encode(label, 'uint8', 2)
    koffi.encode(label, 2, 'uint16', 4) // smaller than the 8-byte ACL header
    koffi.encode(label, 4, 'uint16', 1)
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), label, 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('treats a label ACE that would overrun its ACL as no exact label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const label = allocBytes(32)
    koffi.encode(label, 'uint8', 2)
    koffi.encode(label, 2, 'uint16', 8) // header only: no room for any ACE
    koffi.encode(label, 4, 'uint16', 1)
    koffi.encode(label, 10, 'uint16', 100) // the walk reads a lying ACE size
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftGrantedAcl(sid, world, true), label, 6n),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not treat a no-write-up ACL Allow ACE as the mandatory label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      // Same mask and SID, but an ACCESS_ALLOWED_ACE is not a mandatory label.
      getNamedSecurityInfoW: readStub(
        craftGrantedAcl(sid, world, true),
        craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowSid, true),
        6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })

  it('does not treat a label ACE granting write-up as the exact label', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn(() => 0)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(
        craftGrantedAcl(sid, world, true),
        craftAcl(abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, 0, lowSid, true),
        6n,
      ),
      setNamedSecurityInfoW,
    })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
  })
})

describe('the decoupled DACL / LABEL apply', () => {
  it('applies the grant in a DACL-only call followed by a LABEL-only call carrying the label ACE', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => 0)
    const api = aclApi({ setNamedSecurityInfoW })
    grantWrite(api, 'C:\\granted', sid, lowSid, world)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2)
    const daclCall = requireApplyCall(setNamedSecurityInfoW, 0)
    const labelCall = requireApplyCall(setNamedSecurityInfoW, 1)
    // Step A: the DACL edit alone — no label bit, no SACL pointer.
    expect(daclCall[2] & abi.DACL_SECURITY_INFORMATION).toBe(abi.DACL_SECURITY_INFORMATION)
    expect(daclCall[2] & abi.LABEL_SECURITY_INFORMATION).toBe(0)
    expect(daclCall[5]).toBe(9n) // the merged capability + deny ACL
    expect(daclCall[6]).toBeNull()
    // Step C: the label edit alone — the LABEL bit, the Low ACE in the SACL slot.
    expect(labelCall[2]).toBe(abi.LABEL_SECURITY_INFORMATION)
    expect(labelCall[5]).toBeNull()
    expect(labelCall[6]).toBe(11n) // the label ACL built by buildLowLabelAcl
  })

  it('writes the LABEL through the WRITE_OWNER assist when the privilege cannot be enabled', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const selfUser = craftSid(1, 1, [0, 0, 0, 0, 0, 5])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => 0)
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      setNamedSecurityInfoW,
      adjustTokenPrivileges: vi.fn(() => 0), // the enable fails: the assist is the label path
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      // A real (non-null) DACL for the assist to merge the temporary WRITE_OWNER into.
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) {
          koffi.encode(info, 0, PVOID, ptrAddress(selfUser)) // TOKEN_USER.Sid
          return 1
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
      copySid: vi.fn(() => 1),
      localFree,
    })
    expect(() => {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    }).not.toThrow()
    // Without the privilege the label goes out through the assist: the DACL step,
    // the inherited WRITE_OWNER grant, the LABEL write, then the verbatim restore.
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(4)
    const daclCall = requireApplyCall(setNamedSecurityInfoW, 0)
    expect(daclCall[2] & abi.DACL_SECURITY_INFORMATION).toBe(abi.DACL_SECURITY_INFORMATION)
    expect(daclCall[2] & abi.LABEL_SECURITY_INFORMATION).toBe(0)
    expect(requireApplyCall(setNamedSecurityInfoW, 1)[2]).toBe(abi.DACL_SECURITY_INFORMATION) // the WO grant pass
    const labelCall = requireApplyCall(setNamedSecurityInfoW, 2)
    expect(labelCall[2]).toBe(abi.LABEL_SECURITY_INFORMATION)
    expect(labelCall[6]).toBe(11n) // the label ACL built by buildLowLabelAcl
    expect(requireApplyCall(setNamedSecurityInfoW, 3)[2]).toBe(abi.DACL_SECURITY_INFORMATION) // the restore pass
    // The label ACL is released; no degrade warning — the label was applied.
    expect(localFree).toHaveBeenCalledWith(11n)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails closed when the privilege bindings are missing (the assist cannot read the caller identity)', () => {
    // A partial stub without openProcess/openProcessToken/getTokenInformation/
    // lookupPrivilegeValueW/adjustTokenPrivileges: the privilege helper reports
    // it unavailable AND the WRITE_OWNER assist cannot read the caller's SID,
    // so the label never goes out. The grant fails closed — the applied DACL
    // half is never reported as a usable workspace.
    const { api, setNamedSecurityInfoW } = (() => {
      const base = aclApi({})
      const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => 0)
      const partialApi: Partial<Win32Bindings> = { ...base, setNamedSecurityInfoW }
      delete partialApi.openProcess
      delete partialApi.openProcessToken
      delete partialApi.getTokenInformation
      delete partialApi.lookupPrivilegeValueW
      delete partialApi.adjustTokenPrivileges
      return { api: partialApi as Win32Bindings, setNamedSecurityInfoW }
    })()
    expect(() => {
      grantWrite(api, 'C:\\granted', craftSid(1, 0), craftLowLabelSid(), craftWorldSid())
    }).toThrow(/WRITE_OWNER assist was attempted and failed/)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // the DACL step only: no label write
    const daclCall = requireApplyCall(setNamedSecurityInfoW, 0)
    expect(daclCall[2] & abi.LABEL_SECURITY_INFORMATION).toBe(0)
  })

  it('throws fail-closed when the LABEL is denied with the privilege enabled and the assist cannot run', () => {
    // Privilege enabled but the write denied: the defensive assist still runs,
    // aborts here because this stub has no CopySid binding, and the grant fails
    // closed naming the true gate instead of reporting success.
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const api = aclApi({ setNamedSecurityInfoW })
    expect(() => {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    }).toThrow(/WRITE_OWNER/)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2) // DACL + one LABEL, no assist writes
    const labelCall = requireApplyCall(setNamedSecurityInfoW, 1)
    expect(labelCall[2]).toBe(abi.LABEL_SECURITY_INFORMATION)
  })

  it('writes the LABEL through a temporary inherited caller WRITE_OWNER and restores the DACL', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const selfUser = craftSid(1, 1, [0, 0, 0, 0, 0, 5])
    // Call sequence: DACL grant OK, assist WO-grant DACL OK, LABEL OK, restore
    // pre-heal DACL OK. There is no plain LABEL attempt: without the privilege
    // the assist IS the label path.
    const results = [0, 0, 0, 0]
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => results.shift() ?? 0)
    const healModes: number[] = []
    const healMasks: number[] = []
    const healInheritance: number[] = []
    const setEntriesInAclW = vi.fn<Win32Bindings['setEntriesInAclW']>((_count: unknown, entries: Buffer, _old: unknown, newAcl: NativePtr) => {
      koffi.encode(newAcl, PVOID, 9n)
      // Remember the EXPLICIT_ACCESS_W fields of every merge: perms@0, mode@4,
      // grfInheritance@8.
      healMasks.push(koffi.decode(entries, 0, 'uint32') as number)
      healModes.push(koffi.decode(entries, 4, 'int32') as number)
      healInheritance.push(koffi.decode(entries, 8, 'uint32') as number)
      return 0
    })
    const api = aclApi({
      setNamedSecurityInfoW,
      setEntriesInAclW,
      // A real (non-null) DACL to merge the temporary WRITE_OWNER into.
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      adjustTokenPrivileges: vi.fn(() => 0), // no privilege: the assist path
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) {
          koffi.encode(info, 0, PVOID, ptrAddress(selfUser)) // TOKEN_USER.Sid
          return 1
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
      copySid: vi.fn(() => 1),
    })
    expect(() => {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    }).not.toThrow()
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(4)
    expect(requireApplyCall(setNamedSecurityInfoW, 1)[2]).toBe(abi.DACL_SECURITY_INFORMATION) // WO grant pass
    const labelCall = requireApplyCall(setNamedSecurityInfoW, 2)
    expect(labelCall[2]).toBe(abi.LABEL_SECURITY_INFORMATION) // the label went out on the assist
    expect(requireApplyCall(setNamedSecurityInfoW, 3)[2]).toBe(abi.DACL_SECURITY_INFORMATION) // restore pass
    // The restore pass rewrites the pre-heal ACL directly (no merge), so only
    // two merges ran: the grant's own (deny entry packed first) and the assist's
    // WRITE_OWNER grant.
    expect(healModes).toEqual([abi.DENY_ACCESS, abi.GRANT_ACCESS])
    // The regression this fix exists for: the temporary WRITE_OWNER must be
    // inherited (OI)(CI). The label write's eager inheritance walk asks for
    // WRITE_OWNER on EVERY child it descends into, so a root-only grant stamps
    // the root, silently skips the whole tree, and still reports ERROR_SUCCESS.
    expect(healMasks[1]).toBe(abi.WRITE_OWNER)
    expect(healInheritance[1]).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT)
    // The standing grant mask never carries WRITE_OWNER: the assist is transient.
    expect(healMasks[0]! & abi.WRITE_OWNER).toBe(0)
  })

  it('fails closed when the LABEL stays denied even after the WRITE_OWNER assist', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    const selfUser = craftSid(1, 1, [0, 0, 0, 0, 0, 5])
    // The LABEL denies even with the temporary WRITE_OWNER held: DACL grant OK,
    // assist grant OK, LABEL 5, restore OK.
    const results = [0, 0, abi.ERROR_ACCESS_DENIED, 0]
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => results.shift() ?? 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      // A real (non-null) DACL so the assist's WRITE_OWNER merge can proceed.
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      adjustTokenPrivileges: vi.fn(() => 0), // no privilege
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) {
          koffi.encode(info, 0, PVOID, ptrAddress(selfUser))
          return 1
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
      copySid: vi.fn(() => 1),
    })
    let caught: unknown
    try {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).win32Code).toBe(abi.ERROR_ACCESS_DENIED)
    expect((caught as Error).message).toContain('WRITE_OWNER')
    expect((caught as Error).message).toContain('WRITE_OWNER assist was attempted and failed')
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(4) // DACL, assist grant, LABEL, restore
  })

  it('reports the original denial when the assist cannot read the caller identity', () => {
    const sid = craftSid(1, 0)
    const lowSid = craftLowLabelSid()
    const world = craftWorldSid()
    // The identity read fails (no copySid binding) so the assist aborts before
    // its first write and the original denial surfaces unchanged.
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
    })
    expect(() => {
      grantWrite(api, 'C:\\granted', sid, lowSid, world)
    }).toThrow(/WRITE_OWNER assist was attempted and failed/)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // the DACL step only: the assist wrote nothing
  })
})

describe('ensureRelabelPrivilege failure paths', () => {
  it('reports a failed OpenProcessToken without throwing', () => {
    const api = aclApi({ openProcessToken: vi.fn(() => 0), getLastError: vi.fn(() => 87) })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('OpenProcessToken')
    expect(result.reason).toContain('Win32 87')
  })

  it('reports a failed GetTokenInformation read without throwing', () => {
    const api = aclApi({
      getTokenInformation: vi.fn((_token: unknown, _cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        return 0 // the read fails
      }),
      getLastError: vi.fn(() => 22),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('GetTokenInformation')
  })

  it('reports a failed LookupPrivilegeValueW without throwing', () => {
    const api = aclApi({ lookupPrivilegeValueW: vi.fn(() => 0), getLastError: vi.fn(() => 1301) })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('LookupPrivilegeValueW')
  })

  it('reports ERROR_NO_SUCH_PRIVILEGE from a failed AdjustTokenPrivileges', () => {
    const api = aclApi({
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('Win32 1301')
    expect(result.reason).toContain('SeRelabelPrivilege')
  })

  it('enables the privilege and returns the success outcome', () => {
    const lookup = vi.fn<Win32Bindings['lookupPrivilegeValueW']>((_system, _name, luid) => {
      luid.writeUInt32LE(0x00010000, 0)
      luid.writeUInt32LE(0, 4)
      return 1
    })
    // getLastError 0: the clean enable leaves no residual error.
    const api = aclApi({ lookupPrivilegeValueW: lookup, getLastError: vi.fn(() => 0) })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(true)
    expect(result.reason).toBe('')
    expect(lookup.mock.calls.at(0)?.[1]).toBe('SeRelabelPrivilege')
  })

  it('reports the privilege as NOT held when AdjustTokenPrivileges returns TRUE with 1300', () => {
    // The Win32 quirk: the BOOL is TRUE even though the privilege was left
    // unassigned — GetLastError carries ERROR_NOT_ALL_ASSIGNED, and treating
    // the BOOL alone as success is what used to mask the missing privilege.
    const api = aclApi({
      adjustTokenPrivileges: vi.fn(() => 1),
      getLastError: vi.fn(() => abi.ERROR_NOT_ALL_ASSIGNED),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('Win32 1300')
    expect(result.reason).toContain('SeRelabelPrivilege')
  })
})

describe('revokeWrite no-DACL path', () => {
  it('reports nothing to revoke when the read yields neither DACL nor descriptor', () => {
    // The default stub encodes a NULL DACL and a NULL descriptor.
    const api = aclApi()
    const sid = craftSid(1, 0)
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(false)
  })

  it('frees a descriptor that carries no DACL and reports nothing to revoke', () => {
    const localFree = vi.fn(() => 0n as NativePtr)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n), // descriptor WITHOUT a DACL
      localFree,
    })
    const sid = craftSid(1, 0)
    expect(revokeWrite(api, 'C:\\granted', sid)).toBe(false)
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('reports a failed descriptor LocalFree on the no-DACL path', () => {
    const api = aclApi({
      getNamedSecurityInfoW: readStub(null, null, 6n),
      localFree: vi.fn(() => 1n as NativePtr),
    })
    const sid = craftSid(1, 0)
    let caught: unknown
    try {
      revokeWrite(api, 'C:\\granted', sid)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })
})

describe('ensureRelabelPrivilege remaining failure paths', () => {
  it('reports a failed OpenProcess without throwing', () => {
    const api = aclApi({ openProcess: vi.fn(() => 0n as NativePtr), getLastError: vi.fn(() => 5) })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('OpenProcess failed')
    expect(result.reason).toContain('Win32 5')
  })

  it('reports a null token handle without throwing', () => {
    const api = aclApi({
      openProcessToken: vi.fn((_process: unknown, _access: unknown, slot: NativePtr) => {
        koffi.encode(slot, PVOID, 0n)
        return 1
      }),
      getLastError: vi.fn(() => 5),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('null token handle')
  })

  it('survives a failed CloseHandle on the process handle (reports the privilege as unavailable)', () => {
    // The checked CloseHandle at the start of the enable throws into the
    // catch-all, which surfaces the Win32Error as the reason instead of the
    // privilege being silently reported as enabled.
    const api = aclApi({ closeHandle: vi.fn(() => 0), getLastError: vi.fn(() => 5) })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('privilege enable failed')
    expect(result.reason).toContain('CloseHandle failed (Win32 5)')
  })

  it('reports a zero-size TokenPrivileges query without throwing', () => {
    const api = aclApi({
      getTokenInformation: vi.fn((_token: unknown, _cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 0)
          return 0
        }
        return 1
      }),
      getLastError: vi.fn(() => 5),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('size query returned zero')
  })

  it('reports an implausible TokenPrivileges size without throwing', () => {
    const api = aclApi({
      getTokenInformation: vi.fn((_token: unknown, _cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 4)
          return 0
        }
        return 1
      }),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('implausible TokenPrivileges size 4')
  })

  it('reports a token that holds the privilege but could not enable it (1300)', () => {
    const api = aclApi({
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NOT_ALL_ASSIGNED),
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('Win32 1300')
    expect(result.reason).toContain('could not enable it')
  })

  it('reports the generic AdjustTokenPrivileges failure detail for an unknown code', () => {
    const api = aclApi({
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => 1311), // neither 1300 (not-all-assigned) nor 1301 (no-such-privilege)
    })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('Win32 1311')
    expect(result.reason).not.toContain('does not hold')
    expect(result.reason).not.toContain('could not enable it')
  })

  it('reports a non-Error throw from a binding as its string form', () => {
    const api = aclApi({ openProcess: vi.fn(() => { throw 'boom' }) })
    const result = ensureRelabelPrivilege(api, 'test')
    expect(result.enabled).toBe(false)
    expect(result.reason).toContain('(boom)')
  })
})

describe('readCallerUserSid sub-failures (driven through the WRITE_OWNER assist)', () => {
  // Shared scaffolding: a real (non-exact) DACL, the LABEL denied, and the
  // privilege disabled, so every grantWrite goes straight to healLabelAccess and
  // the injected failure lands in the assist's identity read.
  function deniedLabelApi(overrides: Partial<Win32Bindings> = {}) {
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const world = craftWorldSid()
    const api = aclApi({
      setNamedSecurityInfoW,
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      adjustTokenPrivileges: vi.fn(() => 0), // no privilege: the assist is the label path
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      ...overrides,
    })
    return { api, setNamedSecurityInfoW }
  }

  function assertAssistAborted(caught: unknown, setNamedSecurityInfoW: Mock<Win32Bindings['setNamedSecurityInfoW']>): void {
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).win32Code).toBe(abi.ERROR_ACCESS_DENIED)
    expect((caught as Error).message).toContain('WRITE_OWNER assist was attempted and failed')
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // the DACL step only: the assist wrote nothing
  }

  it('reports the denial when the identity OpenProcess fails', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({ openProcess: vi.fn(() => 0n as NativePtr) })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the identity OpenProcessToken fails', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({ openProcessToken: vi.fn(() => 0) })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the identity token handle is null', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      openProcessToken: vi.fn((_process: unknown, _access: unknown, slot: NativePtr) => {
        koffi.encode(slot, PVOID, 0n)
        return 1
      }),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the TokenUser size query is implausible', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          if (cls === abi.TokenUser) {
            koffi.encode(needed, 'uint32', 4)
            return 0
          }
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the TokenUser read fails', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) return 0 // the TokenUser read fails
        info.writeUInt32LE(1, 0)
        return 1
      }),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the TokenUser read yields a null SID', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) {
          koffi.encode(info, 0, PVOID, 0n) // a null SID pointer
          return 1
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when GetLengthSid rejects the identity SID', () => {
    const selfUser = craftSid(1, 1, [0, 0, 0, 0, 0, 5])
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) {
          koffi.encode(info, 0, PVOID, ptrAddress(selfUser))
          return 1
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
      getLengthSid: vi.fn((sid: NativePtr) => (ptrAddress(sid) === ptrAddress(selfUser) ? 0 : 12)),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the identity SID copy allocation fails', () => {
    // First localAlloc (the label ACL) succeeds; the second (the SID copy) fails.
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      localAlloc: vi.fn(() => 0n as NativePtr).mockReturnValueOnce(11n as NativePtr),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when CopySid fails', () => {
    const { api, setNamedSecurityInfoW } = deniedLabelApi({ copySid: vi.fn(() => 0) })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the identity token handle cannot be closed', () => {
    // The identity read itself succeeds; only the checked token CloseHandle in
    // its finally fails, so the heal still aborts on the thrown Win32Error.
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      copySid: vi.fn(() => 1),
      closeHandle: vi.fn(() => 1).mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(0),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })

  it('reports the denial when the identity process handle cannot be closed', () => {
    // The token close (first) succeeds; the checked process-handle close (second)
    // in the finally fails, so the heal aborts on the thrown Win32Error.
    const { api, setNamedSecurityInfoW } = deniedLabelApi({
      copySid: vi.fn(() => 1),
      closeHandle: vi.fn(() => 1).mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(1).mockReturnValueOnce(0),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    assertAssistAborted(caught, setNamedSecurityInfoW)
  })
})

describe('healLabelAccess body failures', () => {
  it('aborts the assist and fails closed when the re-read yields no DACL', () => {
    const world = craftWorldSid()
    const realDacl = craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true)
    let readCalls = 0
    const localFree = vi.fn(() => 0n as NativePtr)
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      getNamedSecurityInfoW: vi.fn((
        _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
        daclSlot: NativePtr, saclSlot: NativePtr, descriptorSlot: NativePtr,
      ) => {
        readCalls++
        const dacl = readCalls === 1 ? realDacl : null
        koffi.encode(daclSlot, PVOID, dacl === null ? 0n : ptrAddress(dacl))
        koffi.encode(saclSlot, PVOID, 0n)
        koffi.encode(descriptorSlot, PVOID, 6n)
        return 0
      }),
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      copySid: vi.fn(() => 1),
      localFree,
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).win32Code).toBe(abi.ERROR_ACCESS_DENIED)
    expect((caught as Error).message).toContain('WRITE_OWNER assist was attempted and failed')
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // the DACL step only: the assist wrote nothing
    expect(localFree).toHaveBeenCalledWith(6n) // the descriptor freed on the no-DACL assist path
    expect(readCalls).toBe(2)
  })

  it('aborts the assist when the WRITE_OWNER merge fails', () => {
    const world = craftWorldSid()
    let mergeCalls = 0
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      setEntriesInAclW: vi.fn((_count: unknown, _entries: Buffer, _old: unknown, newAcl: NativePtr) => {
        mergeCalls++
        if (mergeCalls === 1) {
          koffi.encode(newAcl, PVOID, 9n)
          return 0
        }
        return 1 // the assist's WRITE_OWNER merge fails
      }),
      // A null descriptor on the re-read: the assist's finally skips its descriptor free.
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, null),
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      copySid: vi.fn(() => 1),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).win32Code).toBe(abi.ERROR_ACCESS_DENIED)
    expect((caught as Error).message).toContain('WRITE_OWNER assist was attempted and failed')
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // the DACL step only: the merge failed first
    expect(mergeCalls).toBe(2)
  })

  it('aborts the assist when the temporary WRITE_OWNER grant cannot be written', () => {
    const world = craftWorldSid()
    const results = [0, abi.ERROR_ACCESS_DENIED]
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => results.shift() ?? 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      copySid: vi.fn(() => 1),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).win32Code).toBe(abi.ERROR_ACCESS_DENIED)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(2) // DACL, failed WO grant (no label write, no restore)
  })

  it('warns (label applied) when the restore write fails but the assist succeeded', () => {
    const world = craftWorldSid()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const results = [0, 0, 0, abi.ERROR_ACCESS_DENIED]
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => results.shift() ?? 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      copySid: vi.fn(() => 1),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid()
    expect(() => { grantWrite(api, 'C:\\granted', sid, lowSid, world) }).not.toThrow()
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.at(0)?.[0]).toContain('integrity label applied')
    warn.mockRestore()
  })

  it('warns (label not applied) and fails closed when the label write and the restore both fail', () => {
    const world = craftWorldSid()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const results = [0, 0, abi.ERROR_ACCESS_DENIED, abi.ERROR_ACCESS_DENIED]
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>(() => results.shift() ?? 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      copySid: vi.fn(() => 1),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.at(0)?.[0]).toContain('integrity label not applied')
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(4)
    warn.mockRestore()
  })
})

describe('mergeAndApply LocalFree-result checks', () => {
  it('throws from the checked label-ACL LocalFree when the DACL step fails (grant)', () => {
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    const localFree = vi.fn(() => 1n as NativePtr) // every free reports a non-null handle
    const api = aclApi({
      setNamedSecurityInfoW: vi.fn((_p: unknown, _t: unknown, info: number) =>
        (info & abi.DACL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0),
      localFree,
    })
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
    expect(localFree).toHaveBeenCalledWith(11n) // the label ACL
  })

  it('throws from the checked descriptor LocalFree on the revoke keep path', () => {
    const sid = craftSid(1, 0)
    const foreignSid = craftSid(1, 0, [0, 0, 0, 0, 0, 7]) // a grant for a DIFFERENT sid: keeps the label
    const oldAcl = craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, foreignSid, true)
    const localFree = vi.fn((p: NativePtr) => (ptrAddress(p) === 6n ? (1n as NativePtr) : (0n as NativePtr)))
    const api = aclApi({
      getNamedSecurityInfoW: readStub(oldAcl, null, 6n),
      localFree,
      setNamedSecurityInfoW: vi.fn(() => 0), // the DACL step succeeds
    })
    let caught: unknown
    try { revokeWrite(api, 'C:\\granted', sid) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
    expect(localFree).toHaveBeenCalledWith(6n)
  })

  it('throws from the checked descriptor LocalFree after a fully successful grant', () => {
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    const selfUser = craftSid(1, 1, [0, 0, 0, 0, 0, 5])
    const localFree = vi.fn((p: NativePtr) => (ptrAddress(p) === 6n ? (1n as NativePtr) : (0n as NativePtr)))
    const api = aclApi({
      getNamedSecurityInfoW: readStub(craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true), null, 6n),
      localFree,
      setNamedSecurityInfoW: vi.fn(() => 0), // DACL, assist grant, LABEL, restore all succeed
      adjustTokenPrivileges: vi.fn(() => 0), // privilege disabled: the assist carries the label out
      getTokenInformation: vi.fn((_token: unknown, cls: number, info: Buffer | null, _length: number, needed: NativePtr) => {
        if (info === null) {
          koffi.encode(needed, 'uint32', 8)
          return 0
        }
        if (cls === abi.TokenUser) {
          koffi.encode(info, 0, PVOID, ptrAddress(selfUser)) // TOKEN_USER.Sid
          return 1
        }
        info.writeUInt32LE(1, 0)
        return 1
      }),
      copySid: vi.fn(() => 1),
    })
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('LocalFree')
  })
})

describe('reportLabelFailure system-text detail', () => {
  it('includes the formatted system text in the fail-closed message', () => {
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid(); const world = craftWorldSid()
    const sysText = 'Access is denied.\n\n'
    const formatMessageW = vi.fn((
      _lang: unknown, _source: unknown, _code: number, _flags: unknown,
      buffer: Buffer, _buflen: number, _args: unknown,
    ) => {
      buffer.write(sysText, 0, buffer.length / 2, 'utf16le')
      return sysText.length // chars written, like the real FormatMessageW
    })
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      formatMessageW,
    })
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Error).message).toContain('Access is denied')
    expect((caught as Error).message).toContain('Win32 5: Access is denied')
  })
})

describe('mergeAndApply and healLabelAccess remaining branch edges', () => {
  it('skips the label-ACL free when the DACL step fails on a revoke (no label to own)', () => {
    // A grant for the SAME sid being revoked is not a foreign grant, so the
    // label edit is `clear` — there is no label ACL owned when the DACL step
    // fails, and the checked free is skipped rather than leaking.
    const sid = craftSid(1, 0)
    const oldAcl = craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, abi.GRANT_MASK, sid, true)
    const api = aclApi({
      getNamedSecurityInfoW: readStub(oldAcl, null, 6n),
      setNamedSecurityInfoW: vi.fn((_p: unknown, _t: unknown, info: number) =>
        (info & abi.DACL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0),
    })
    let caught: unknown
    try { revokeWrite(api, 'C:\\granted', sid) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).api).toBe('SetNamedSecurityInfoW')
  })

  it('aborts the assist without a descriptor free when the re-read yields no DACL or descriptor', () => {
    const world = craftWorldSid()
    const realDacl = craftAcl(abi.ACCESS_ALLOWED_ACE_TYPE, 0x100000, world, true)
    let readCalls = 0
    const setNamedSecurityInfoW = vi.fn<Win32Bindings['setNamedSecurityInfoW']>((_p: unknown, _t: unknown, info: number) =>
      (info & abi.LABEL_SECURITY_INFORMATION) !== 0 ? abi.ERROR_ACCESS_DENIED : 0)
    const api = aclApi({
      setNamedSecurityInfoW,
      getNamedSecurityInfoW: vi.fn((
        _path: unknown, _type: unknown, _info: unknown, _owner: unknown, _group: unknown,
        daclSlot: NativePtr, saclSlot: NativePtr, descriptorSlot: NativePtr,
      ) => {
        readCalls++
        const dacl = readCalls === 1 ? realDacl : null
        koffi.encode(daclSlot, PVOID, dacl === null ? 0n : ptrAddress(dacl))
        koffi.encode(saclSlot, PVOID, 0n)
        koffi.encode(descriptorSlot, PVOID, 0n) // null descriptor: no block to free
        return 0
      }),
      adjustTokenPrivileges: vi.fn(() => 0),
      getLastError: vi.fn(() => abi.ERROR_NO_SUCH_PRIVILEGE),
      copySid: vi.fn(() => 1),
    })
    const sid = craftSid(1, 0); const lowSid = craftLowLabelSid()
    let caught: unknown
    try { grantWrite(api, 'C:\\granted', sid, lowSid, world) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Win32Error)
    expect((caught as Win32Error).win32Code).toBe(abi.ERROR_ACCESS_DENIED)
    expect(setNamedSecurityInfoW).toHaveBeenCalledTimes(1) // the DACL step only: the assist wrote nothing
    expect(readCalls).toBe(2)
  })
})
