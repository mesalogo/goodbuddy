// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { app } from './app.js'

describe('ShareServer prototype API', () => {
  it('reports prototype readiness without claiming production readiness', async () => {
    const response = await app.request('/api/v1/public/ready')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ready',
      mode: 'interactive-prototype',
      productionReady: false
    })
  })

  it('returns the organization-scoped console snapshot', async () => {
    const response = await app.request('/api/v1/web/prototype/snapshot')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      instance: { organization: 'MesaLab' },
      pages: {
        devices: expect.any(Array),
        approvals: expect.any(Array),
        myDevices: expect.any(Array)
      }
    })
  })

  it('rejects malformed prototype actions', async () => {
    const response = await app.request('/api/v1/web/prototype/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: '批准申请' })
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_PROTOTYPE_ACTION'
    })
  })
})
