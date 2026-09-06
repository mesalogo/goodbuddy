import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  darwinBootId,
  inspectDarwinProcess,
  listDarwinProcessGroup,
  stopDarwinDescendants
} from './darwin-process-identity'

describe('Darwin process identity', () => {
  const native = process.platform === 'darwin' && process.arch === 'arm64' ? it : it.skip
  native('reads actual process identity and enumerates a dedicated child group', async () => {
    const current = inspectDarwinProcess(process.pid)
    expect(current?.pid).toBe(process.pid)
    expect(current?.executablePath).toBe(realpathSync(process.execPath))
    expect(BigInt(current!.starttime)).toBeGreaterThan(0n)
    expect(darwinBootId()).toMatch(/^[a-f0-9-]{36}$/u)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore'
    })
    await once(child, 'spawn')
    try {
      const identity = inspectDarwinProcess(child.pid!)
      expect(identity?.processGroupId).toBe(child.pid)
      expect(listDarwinProcessGroup(child.pid!)).toContain(child.pid)
      expect(listDarwinProcessGroup(child.pid!)).not.toContain(process.pid)
    } finally {
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
    expect(inspectDarwinProcess(child.pid!)).toBeUndefined()
  })
  native('stops a tool child that starts its own process group', async () => {
    const parent = spawn(process.execPath, ['-e', `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      child.on('spawn',()=>console.log(child.pid));
      setInterval(()=>{},1000);
    `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const [output] = await once(parent.stdout!, 'data')
    const childPid = Number(String(output).trim())
    try {
      expect(inspectDarwinProcess(childPid)?.processGroupId).toBe(childPid)
      await stopDarwinDescendants(parent.pid!, Date.now() + 3000)
      expect(inspectDarwinProcess(childPid)).toBeUndefined()
      expect(inspectDarwinProcess(parent.pid!)).toBeDefined()
    } finally {
      await stopDarwinDescendants(parent.pid!, Date.now() + 3000)
      const exited = once(parent, 'exit')
      parent.kill()
      await exited
    }
  })
})
