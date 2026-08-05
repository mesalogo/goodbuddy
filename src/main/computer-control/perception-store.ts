import {
  createHmac,
  randomBytes,
  randomUUID
} from 'node:crypto'
import type {
  ComputerControlObservation,
  ComputerControlRisk
} from '../../shared/computer-control-contracts'
import type {
  DriverElement,
  DriverObservation,
  NativeElementIdentity
} from './driver'
import { ComputerControlFailure } from './errors'

export const COMPUTER_CONTROL_OBSERVATION_FRESH_MS = 3_000
export const COMPUTER_CONTROL_MAX_ELEMENTS = 200

type StoredElement = {
  nativeIdentity: NativeElementIdentity
  driverElement: DriverElement
  risk: ComputerControlRisk
}

type StoredObservation = {
  contract: ComputerControlObservation
  elements: Map<string, StoredElement>
  consumed: boolean
}

const boundedDisplayText = (
  value: string,
  maximumLength: number,
  fallback = ''
): string => {
  const clean = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, maximumLength)
  return clean || fallback
}

export class ComputerControlPerceptionStore {
  private readonly observations = new Map<string, StoredObservation>()
  private readonly revisions = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID,
    private readonly hmacKey: Buffer = randomBytes(32)
  ) {}

  create(
    leaseId: string,
    observation: DriverObservation,
    classify: (element: DriverElement) => ComputerControlRisk
  ): ComputerControlObservation {
    if (observation.elements.length > COMPUTER_CONTROL_MAX_ELEMENTS) {
      throw new ComputerControlFailure(
        'internal_error',
        'Driver observation exceeded the element limit'
      )
    }

    const revision = (this.revisions.get(leaseId) ?? 0) + 1
    this.revisions.set(leaseId, revision)
    this.deleteLeaseObservations(leaseId)

    const observationId = this.createId()
    const storedElements = new Map<string, StoredElement>()
    const elements = observation.elements.map((element, index) => {
      const risk = classify(element)
      const ref = createHmac('sha256', this.hmacKey)
        .update(`${observationId}\u0000${revision}\u0000${index}`)
        .digest('base64url')
      storedElements.set(ref, {
        nativeIdentity: element.nativeIdentity,
        driverElement: element,
        risk
      })
      return {
        ref,
        role: element.role,
        name: boundedDisplayText(element.name, 256, element.role),
        enabled: element.enabled,
        focused: element.focused,
        risk,
        blocked: risk === 'forbidden'
      }
    })

    const contract: ComputerControlObservation = {
      observationId,
      leaseId,
      revision,
      capturedAt: this.now(),
      windowTitle: boundedDisplayText(
        observation.windowTitle,
        256
      ),
      elements
    }
    this.observations.set(observationId, {
      contract,
      elements: storedElements,
      consumed: false
    })
    return structuredClone(contract)
  }

  resolve(
    leaseId: string,
    observationId: string,
    revision: number,
    elementRef: string
  ): StoredElement {
    const observation = this.observations.get(observationId)
    if (!observation || observation.contract.leaseId !== leaseId) {
      throw new ComputerControlFailure(
        'observation_not_found',
        'Computer control observation was not found'
      )
    }
    if (observation.contract.revision !== revision) {
      throw new ComputerControlFailure(
        'observation_stale',
        'Computer control observation revision changed',
        true
      )
    }
    if (
      this.now() - observation.contract.capturedAt >=
      COMPUTER_CONTROL_OBSERVATION_FRESH_MS
    ) {
      throw new ComputerControlFailure(
        'observation_stale',
        'Computer control observation is stale',
        true
      )
    }
    if (observation.consumed) {
      throw new ComputerControlFailure(
        'observation_consumed',
        'Computer control observation was already used'
      )
    }
    const element = observation.elements.get(elementRef)
    if (!element) {
      throw new ComputerControlFailure(
        'element_not_found',
        'Computer control element was not found'
      )
    }
    return element
  }

  consume(observationId: string): void {
    const observation = this.observations.get(observationId)
    if (!observation) {
      throw new ComputerControlFailure(
        'observation_not_found',
        'Computer control observation was not found'
      )
    }
    if (observation.consumed) {
      throw new ComputerControlFailure(
        'observation_consumed',
        'Computer control observation was already used'
      )
    }
    observation.consumed = true
  }

  revokeLease(leaseId: string): void {
    this.deleteLeaseObservations(leaseId)
    this.revisions.delete(leaseId)
  }

  private deleteLeaseObservations(leaseId: string): void {
    for (const [observationId, observation] of this.observations) {
      if (observation.contract.leaseId === leaseId) {
        this.observations.delete(observationId)
      }
    }
  }
}
