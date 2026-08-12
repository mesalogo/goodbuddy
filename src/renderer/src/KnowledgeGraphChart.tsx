import {
  Graph,
  GraphEvent,
  NodeEvent,
  type GraphOptions,
  type IElementDragEvent,
  type IElementEvent,
  type NodeData
} from '@antv/g6'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  KnowledgeGraphNode,
  KnowledgeGraphRelation
} from '../../shared/contracts'
import { useDocumentTheme } from './use-document-theme'

type ChartKnowledgeGraphNode = Omit<
  KnowledgeGraphNode,
  'aliases' | 'evidenceIds'
> & {
  aliases?: readonly string[]
  evidenceIds?: readonly string[]
}

type ChartKnowledgeGraphRelation = Omit<
  KnowledgeGraphRelation,
  'evidenceIds'
> & {
  evidenceIds?: readonly string[]
}

type KnowledgeGraphChartProps = {
  nodes: readonly ChartKnowledgeGraphNode[]
  relations: readonly ChartKnowledgeGraphRelation[]
  selectedNodeId?: string
  fitViewRequest: number
  zoom: number
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void
  onSelectNode: (nodeId: string) => void
  onZoomChange: (zoom: number) => void
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
}

function graphErrorMessage(error: unknown, fallback: string): string {
  return (
    (error instanceof Error ? error.message : fallback)
      .trim()
      .slice(0, 500) || fallback
  )
}

function graphTypeStyles(
  nodes: readonly ChartKnowledgeGraphNode[],
  locale: string
): Map<
  string,
  { color: string; borderColor: string }
> {
  const palette = Array.from({ length: 8 }, (_, index) => ({
    color: readToken(`--graph-node-${index + 1}`),
    borderColor: readToken(`--graph-node-${index + 1}-border`)
  }))
  return new Map(
    [...new Set(nodes.map((node) => node.type))]
      .sort((left, right) => left.localeCompare(right, locale))
      .map((type, index) => [type, palette[index % palette.length]!])
  )
}

function graphRevision(
  nodes: readonly ChartKnowledgeGraphNode[],
  relations: readonly ChartKnowledgeGraphRelation[]
): string {
  return JSON.stringify({
    nodes: nodes.map((node) => [
      node.id,
      node.label,
      node.type
    ]),
    relations: relations.map((relation) => [
      relation.id,
      relation.sourceId,
      relation.targetId,
      relation.type
    ])
  })
}

type G6NodeMetadata = {
  label: string
  entityType: string
  degree: number
  size: number
  fill: string
  stroke: string
}

type G6EdgeMetadata = {
  label: string
  description?: string
}

function nodeMetadata(node: NodeData): G6NodeMetadata {
  return node.data as G6NodeMetadata
}

function createPresentation(
  nodes: readonly ChartKnowledgeGraphNode[],
  relations: readonly ChartKnowledgeGraphRelation[],
  locale: string,
  relationFallback: string
): Pick<
  GraphOptions,
  'data' | 'layout' | 'node' | 'edge' | 'behaviors' | 'plugins'
> {
  const textPrimary = readToken('--text-primary')
  const textSecondary = readToken('--text-secondary')
  const accent = readToken('--accent')
  const accentSubtle = readToken('--accent-subtle')
  const surfaceRaised = readToken('--surface-raised')
  const borderDefault = readToken('--border-default')
  const typeStyles = graphTypeStyles(nodes, locale)
  const dense = nodes.length > 24
  const degreeByNodeId = new Map(nodes.map((node) => [node.id, 0]))
  for (const relation of relations) {
    degreeByNodeId.set(
      relation.sourceId,
      (degreeByNodeId.get(relation.sourceId) ?? 0) + 1
    )
    degreeByNodeId.set(
      relation.targetId,
      (degreeByNodeId.get(relation.targetId) ?? 0) + 1
    )
  }
  const maximumDegree = Math.max(1, ...degreeByNodeId.values())
  const showEdgeLabels =
    nodes.length <= 18 && relations.length <= 24

  return {
    data: {
      nodes: nodes.map((node) => {
        const typeStyle = typeStyles.get(node.type) ?? {
          color: accentSubtle,
          borderColor: accent
        }
        const degree = degreeByNodeId.get(node.id) ?? 0
        const degreeRatio = Math.sqrt(degree / maximumDegree)
        const size = dense
          ? 16 + degreeRatio * 16
          : 32 + degreeRatio * 16
        return {
          id: node.id,
          data: {
            label:
              node.label.length > 12
                ? `${node.label.slice(0, 12)}…`
                : node.label,
            entityType: node.type,
            degree,
            size,
            fill: typeStyle.color,
            stroke: typeStyle.borderColor
          } satisfies G6NodeMetadata,
          style: {
            x: node.x,
            y: node.y
          }
        }
      }),
      edges: relations.map((relation) => ({
        id: relation.id,
        source: relation.sourceId,
        target: relation.targetId,
        data: {
          label: relation.type,
          description: relation.description
        } satisfies G6EdgeMetadata
      }))
    },
    layout: {
      type: 'd3-force',
      animate: false,
      centerStrength: 0.8,
      linkDistance: dense ? 44 : 64,
      edgeStrength: dense ? 0.28 : 0.4,
      edgeIterations: 2,
      nodeStrength: dense ? -45 : -70,
      theta: 0.8,
      preventOverlap: true,
      collideStrength: 0.9,
      collideIterations: 2,
      nodeSize: (datum: Record<string, unknown>) => {
        const metadata = datum.data as G6NodeMetadata | undefined
        return metadata?.size ?? 24
      },
      nodeSpacing: dense ? 10 : 14,
      x: false,
      y: false,
      radialRadius: 0,
      radialStrength: dense ? 0.055 : 0.04,
      alphaMin: 0.015,
      alphaDecay: 0.045,
      velocityDecay: 0.42
    },
    node: {
      type: 'circle',
      style: {
        size: (datum) => nodeMetadata(datum).size,
        fill: (datum) => nodeMetadata(datum).fill,
        stroke: (datum) => nodeMetadata(datum).stroke,
        lineWidth: 1.5,
        label: true,
        labelText: (datum) => nodeMetadata(datum).label,
        labelFill: textPrimary,
        labelFontSize: dense ? 11 : 12,
        labelFontWeight: 550,
        labelPlacement: 'right',
        labelOffsetX: 6,
        labelMaxWidth: 120
      },
      state: {
        active: {
          lineWidth: 2.5,
          stroke: accent,
          label: true
        },
        selected: {
          lineWidth: 3,
          stroke: accent,
          halo: true,
          haloStroke: accent,
          haloLineWidth: 6,
          haloOpacity: 0.18,
          label: true
        }
      },
      animation: false
    },
    edge: {
      type: 'line',
      style: {
        stroke: borderDefault,
        lineWidth: 1.2,
        opacity: 0.72,
        endArrow: true,
        endArrowSize: 6,
        label: showEdgeLabels,
        labelText: (datum) =>
          String((datum.data as G6EdgeMetadata | undefined)?.label ?? ''),
        labelFill: textSecondary,
        labelFontSize: 11,
        labelBackground: true,
        labelBackgroundFill: surfaceRaised,
        labelPadding: [2, 4]
      },
      state: {
        active: {
          stroke: accent,
          lineWidth: 2,
          opacity: 1
        }
      },
      animation: false
    },
    behaviors: [
      'drag-canvas',
      'zoom-canvas',
      {
        type: 'drag-element-force',
        fixed: true
      },
      {
        type: 'auto-adapt-label',
        sortNode: { type: 'degree' },
        padding: 4,
        throttle: 80
      }
    ],
    plugins: [
      {
        type: 'tooltip',
        enable: (event: IElementEvent) =>
          event.targetType === 'node' || event.targetType === 'edge',
        getContent: (
          event: IElementEvent,
          items: Array<{ data?: Record<string, unknown> }>
        ) => {
          const content = document.createElement('div')
          const datum = items[0]
          if (event.targetType === 'node') {
            const metadata = datum?.data as
              | G6NodeMetadata
              | undefined
            content.textContent = [metadata?.label, metadata?.entityType]
              .filter(Boolean)
              .join(' · ')
          } else {
            const metadata = datum?.data as
              | G6EdgeMetadata
              | undefined
            content.textContent =
              metadata?.description || metadata?.label || relationFallback
          }
          return content
        }
      }
    ]
  }
}

export function KnowledgeGraphChart({
  nodes,
  relations,
  selectedNodeId,
  fitViewRequest,
  zoom,
  onMoveNode,
  onSelectNode,
  onZoomChange
}: KnowledgeGraphChartProps): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const renderErrorFallback = t('graphChart.renderError')
  const relationFallback = t('graphChart.relation')
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<Graph | null>(null)
  const onMoveNodeRef = useRef(onMoveNode)
  const onSelectNodeRef = useRef(onSelectNode)
  const onZoomChangeRef = useRef(onZoomChange)
  const nodesRef = useRef(nodes)
  const relationsRef = useRef(relations)
  const selectedNodeIdRef = useRef(selectedNodeId)
  const zoomRef = useRef(zoom)
  const fitViewRequestRef = useRef(fitViewRequest)
  const appliedZoomRef = useRef<number | undefined>(undefined)
  const renderVersionRef = useRef(0)
  const renderedRevisionRef = useRef<string | undefined>(undefined)
  const pendingRenderRef = useRef<
    { graph: Graph; promise: Promise<void> } | undefined
  >(undefined)
  const dataRevision = useMemo(
    () => graphRevision(nodes, relations),
    [nodes, relations]
  )
  const documentTheme = useDocumentTheme()
  const [renderError, setRenderError] = useState<string>()

  useEffect(() => {
    nodesRef.current = nodes
    relationsRef.current = relations
  }, [nodes, relations])

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId
  }, [selectedNodeId])

  useEffect(() => {
    onMoveNodeRef.current = onMoveNode
    onSelectNodeRef.current = onSelectNode
    onZoomChangeRef.current = onZoomChange
  }, [onMoveNode, onSelectNode, onZoomChange])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    if (fitViewRequestRef.current === fitViewRequest) {
      return
    }
    fitViewRequestRef.current = fitViewRequest
    const graph = graphRef.current
    if (
      !graph ||
      renderedRevisionRef.current !== dataRevision
    ) {
      return
    }
    void graph
      .fitView(
        {
          when: 'always',
          direction: 'both'
        },
        false
      )
      .then(() => {
        if (graphRef.current !== graph) {
          return
        }
        const nextZoom = graph.getZoom()
        if (Number.isFinite(nextZoom)) {
          zoomRef.current = nextZoom
          appliedZoomRef.current = nextZoom
          onZoomChangeRef.current(nextZoom)
        }
      })
      .catch((error: unknown) => {
        if (graphRef.current === graph) {
          setRenderError(graphErrorMessage(error, renderErrorFallback))
        }
      })
  }, [dataRevision, fitViewRequest, renderErrorFallback])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const graph = new Graph({
      container,
      animation: false,
      autoFit: {
        type: 'view',
        options: {
          when: 'overflow',
          direction: 'both'
        },
        animation: false
      },
      padding: 40,
      zoom: zoomRef.current,
      zoomRange: [0.5, 2]
    })
    graphRef.current = graph

    const selectNode = (event: IElementEvent): void => {
      onSelectNodeRef.current(String(event.target.id))
    }
    const persistNodePosition = (event: IElementDragEvent): void => {
      const id = String(event.target.id)
      const position = graph.getElementPosition(id)
      if (
        !Number.isFinite(position[0]) ||
        !Number.isFinite(position[1])
      ) {
        return
      }
      onMoveNodeRef.current(id, {
        x: Number(position[0]),
        y: Number(position[1])
      })
    }
    const persistViewport = (): void => {
      const nextZoom = graph.getZoom()
      if (
        Number.isFinite(nextZoom) &&
        Math.abs(nextZoom - zoomRef.current) >= 0.001
      ) {
        zoomRef.current = nextZoom
        appliedZoomRef.current = nextZoom
        onZoomChangeRef.current(nextZoom)
      }
    }
    const resize = (): void => graph.resize()

    graph.on(NodeEvent.CLICK, selectNode)
    graph.on(NodeEvent.DRAG_END, persistNodePosition)
    graph.on(GraphEvent.AFTER_TRANSFORM, persistViewport)

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(container)
    } else {
      window.addEventListener('resize', resize)
    }

    return () => {
      renderVersionRef.current += 1
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      graph.off(NodeEvent.CLICK, selectNode)
      graph.off(NodeEvent.DRAG_END, persistNodePosition)
      graph.off(GraphEvent.AFTER_TRANSFORM, persistViewport)
      const pendingRender = pendingRenderRef.current
      if (pendingRender?.graph === graph) {
        void pendingRender.promise.finally(() => graph.destroy())
      } else {
        graph.destroy()
      }
      graphRef.current = null
    }
  }, [])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) {
      return
    }
    const presentation = createPresentation(
      nodesRef.current,
      relationsRef.current,
      locale,
      relationFallback
    )
    graph.setOptions({
      ...presentation,
      animation: false,
      autoFit: {
        type: 'view',
        options: {
          when: 'overflow',
          direction: 'both'
        },
        animation: false
      },
      padding: 40,
      zoomRange: [0.5, 2]
    })
    const renderVersion = ++renderVersionRef.current
    setRenderError(undefined)
    const renderPromise = graph
      .render()
      .then(async () => {
        if (
          graphRef.current !== graph ||
          renderVersionRef.current !== renderVersion
        ) {
          return
        }
        renderedRevisionRef.current = dataRevision
        await graph.fitView(
          {
            when: 'always',
            direction: 'both'
          },
          false
        )
        appliedZoomRef.current = graph.getZoom()
        const states = Object.fromEntries(
          nodesRef.current.map((node) => [
            node.id,
            node.id === selectedNodeIdRef.current ? ['selected'] : []
          ])
        )
        await graph.setElementState(states, false)
      })
      .catch((error: unknown) => {
        if (
          graphRef.current === graph &&
          renderVersionRef.current === renderVersion
        ) {
          setRenderError(
            graphErrorMessage(error, renderErrorFallback)
          )
        }
      })
    pendingRenderRef.current = {
      graph,
      promise: renderPromise
    }
    void renderPromise.finally(() => {
      if (
        pendingRenderRef.current?.graph === graph &&
        renderVersionRef.current === renderVersion
      ) {
        pendingRenderRef.current = undefined
      }
    })
  }, [
    dataRevision,
    locale,
    relationFallback,
    renderErrorFallback,
    documentTheme
  ])

  useEffect(() => {
    const graph = graphRef.current
    if (
      !graph ||
      renderedRevisionRef.current === undefined ||
      renderedRevisionRef.current !== dataRevision
    ) {
      return
    }
    if (
      appliedZoomRef.current !== undefined &&
      Math.abs(appliedZoomRef.current - zoom) < 0.001
    ) {
      return
    }
    void graph.zoomTo(zoom, false).catch((error: unknown) => {
      if (graphRef.current === graph) {
        setRenderError(graphErrorMessage(error, renderErrorFallback))
      }
    })
    appliedZoomRef.current = zoom
  }, [dataRevision, renderErrorFallback, zoom])

  useEffect(() => {
    const graph = graphRef.current
    if (
      !graph ||
      renderedRevisionRef.current !== dataRevision
    ) {
      return
    }
    const states = Object.fromEntries(
      nodesRef.current.map((node) => [
        node.id,
        node.id === selectedNodeId ? ['selected'] : []
      ])
    )
    void graph.setElementState(states, false).catch((error: unknown) => {
      if (graphRef.current === graph) {
        setRenderError(graphErrorMessage(error, renderErrorFallback))
      }
    })
  }, [dataRevision, renderErrorFallback, selectedNodeId])

  return (
    <div className="knowledge-graph__chart-shell">
      <div
        aria-label={t('graphChart.ariaLabel')}
        className="knowledge-graph__chart"
        ref={containerRef}
        role="img"
      />
      {renderError && (
        <div className="knowledge-graph__chart-error" role="alert">
          {t('graphChart.errorWithContext', { error: renderError })}
        </div>
      )}
    </div>
  )
}
