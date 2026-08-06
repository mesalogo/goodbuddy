import { describe, expect, it } from 'vitest'
import { isIntranetHostname } from './intranet-hostname'

describe('isIntranetHostname', () => {
  it.each([
    'localhost',
    'printer',
    'models.internal',
    'models.corp.local',
    '10.7.0.23',
    '127.0.0.2',
    '100.64.0.1',
    '172.16.4.2',
    '192.168.1.20',
    '[fd12:3456::1]'
  ])('accepts the intranet host %s', (hostname) => {
    expect(isIntranetHostname(hostname)).toBe(true)
  })

  it.each([
    'models.example.com',
    '8.8.8.8',
    '169.254.169.254',
    '100.100.100.200',
    '[fd00:ec2::254]',
    'metadata.google.internal'
  ])('rejects the public or metadata host %s', (hostname) => {
    expect(isIntranetHostname(hostname)).toBe(false)
  })
})
