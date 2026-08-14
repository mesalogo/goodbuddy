import process from 'node:process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  {
    name: 'goodbuddy-web-3d-game-fixture',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
)

const blueprints = {
  'neon-ruins': {
    title: 'Prism Relay',
    palette: {
      sky: '#08111f',
      floor: '#17243d',
      player: '#68f6ff',
      collectible: '#ffd166',
      hazard: '#ff4d6d',
      exit: '#7bf1a8'
    },
    setting:
      'A compact neon ruin suspended above a dark energy field.'
  },
  'sky-temple': {
    title: 'Aether Beacon',
    palette: {
      sky: '#87ceeb',
      floor: '#d9c7a3',
      player: '#235789',
      collectible: '#f6ae2d',
      hazard: '#d1495b',
      exit: '#2a9d8f'
    },
    setting:
      'A bright floating temple built from stone platforms and wind gates.'
  },
  'crystal-cavern': {
    title: 'Crystal Circuit',
    palette: {
      sky: '#09051a',
      floor: '#241b4b',
      player: '#8be9fd',
      collectible: '#f1fa8c',
      hazard: '#ff79c6',
      exit: '#50fa7b'
    },
    setting:
      'A luminous cavern whose crystal relays awaken an ancient portal.'
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_game_blueprint',
      title: 'Create a deterministic 3D game blueprint',
      description:
        'Returns a bounded offline WebGL game design with controls, level geometry, rules, and play-test acceptance criteria.',
      inputSchema: {
        type: 'object',
        properties: {
          theme: {
            type: 'string',
            enum: ['neon-ruins', 'sky-temple', 'crystal-cavern']
          },
          seed: { type: 'string' },
          targetCount: { type: 'number' }
        },
        required: ['theme', 'seed', 'targetCount'],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'create_game_blueprint') {
      throw new Error('Unknown tool')
    }
    const args = request.params.arguments
    const theme = args?.theme
    const seed = args?.seed
    const targetCount = args?.targetCount
    if (
      (theme !== 'neon-ruins' &&
        theme !== 'sky-temple' &&
        theme !== 'crystal-cavern') ||
      typeof seed !== 'string' ||
      seed.trim().length === 0 ||
      seed.length > 64 ||
      typeof targetCount !== 'number' ||
      !Number.isInteger(targetCount) ||
      targetCount < 3 ||
      targetCount > 8
    ) {
      throw new Error('Invalid blueprint arguments')
    }
    const selected = blueprints[theme]
    const blueprint = {
      schemaVersion: 1,
      seed,
      title: selected.title,
      setting: selected.setting,
      renderer: {
        api: 'WebGL2',
        projection: 'perspective',
        requiredFeatures: [
          'depth-test',
          'directional-light',
          'distance-fog',
          'resize-aware-canvas'
        ],
        networkAssets: false
      },
      player: {
        spawn: [0, 0.6, 6],
        moveSpeed: 5.5,
        jumpVelocity: 7.5,
        controls: {
          move: ['WASD', 'Arrow keys'],
          jump: ['Space'],
          pause: ['Escape'],
          restart: ['R']
        }
      },
      objective: {
        type: 'collect-and-exit',
        collectible: 'energy prism',
        targetCount,
        exitUnlocksAt: targetCount,
        victoryText: 'Relay synchronized'
      },
      level: {
        bounds: { x: [-12, 12], z: [-10, 10], fallY: -5 },
        platforms: [
          { center: [0, 0, 0], size: [18, 1, 14] },
          { center: [-8, 1.5, -5], size: [5, 1, 4] },
          { center: [8, 2.5, -4], size: [5, 1, 5] }
        ],
        hazards: [
          {
            kind: 'moving-energy-bar',
            axis: 'x',
            range: [-6, 6],
            speed: 2.4,
            penalty: 'reset-player-and-increment-hits'
          }
        ],
        exit: { center: [0, 1, -8], lockedColor: '#56606f' }
      },
      palette: selected.palette,
      feedback: [
        'collectible-pulse-and-chime',
        'hazard-flash-and-low-tone',
        'exit-unlock-color-change',
        'victory-overlay-with-restart'
      ],
      acceptance: {
        minimumFramesObserved: 30,
        requiredStates: ['ready', 'playing', 'won'],
        testSurface: 'window.__GOODBUDDY_GAME__',
        checks: [
          'keyboard and test inputs share the same action state',
          'collecting every prism unlocks the exit',
          'entering the unlocked exit wins',
          'restart restores score, player, hazards, and exit',
          'no external network requests or console errors'
        ]
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(blueprint)
        }
      ]
    }
})

await server.connect(
  new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1024 * 1024
  })
)
