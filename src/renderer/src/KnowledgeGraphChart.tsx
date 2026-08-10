import { GraphChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import {
  init,
  use as registerECharts,
  type ECElementEvent,
  type ECharts,
  type EChartsCoreOption
} from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KnowledgeGraphNode,
  KnowledgeGraphRelation
} from '../../shared/contracts'

registerECharts([GraphChart, TooltipComponent, CanvasRenderer])

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
  zoom: number
  onMoveNode: (nodeId: string, position: { x: number; y: number }) => void
  onSelectNode: (nodeId: string) => void
  onZoomChange: (zoom: number) => void
}

type GraphViewport = {
  center?: [number | string, number | string]
}

type NodeDrag = {
  id: string
  pointerX: number
  pointerY: number
  x: number
  y: number
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
}

function graphTypeStyles(nodes: readonly ChartKnowledgeGraphNode[]): Map<
  string,
  { color: string; borderColor: string }
> {
  const palette = Array.from({ length: 8 }, (_, index) => ({
    color: readToken(`--graph-node-${index + 1}`),
    borderColor: readToken(`--graph-node-${index + 1}-border`)
  }))
  return new Map(
    [...new Set(nodes.map((node) => node.type))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
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
      node.type,
      node.x,
      node.y
    ]),
    relations: relations.map((relation) => [
      relation.id,
      relation.sourceId,
      relation.targetId,
      relation.type
    ])
  })
}

function createOption({
  nodes,
  relations,
  selectedNodeId,
  zoom
}: Pick<
  KnowledgeGraphChartProps,
  'nodes' | 'relations' | 'selectedNodeId' | 'zoom'
>): EChartsCoreOption {
  const textPrimary = readToken('--text-primary')
  const textSecondary = readToken('--text-secondary')
  const textMuted = readToken('--text-muted')
  const accent = readToken('--accent')
  const accentSubtle = readToken('--accent-subtle')
  const surfaceRaised = readToken('--surface-raised')
  const borderDefault = readToken('--border-default')
  const typeStyles = graphTypeStyles(nodes)
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
  const keyNodeCount = Math.min(
    nodes.length,
    Math.max(8, Math.min(16, Math.round(Math.sqrt(nodes.length) * 1.4)))
  )
  const keyNodeIds = new Set(
    [...nodes]
      .sort((left, right) => {
        const degreeDifference =
          (degreeByNodeId.get(right.id) ?? 0) -
          (degreeByNodeId.get(left.id) ?? 0)
        return (
          degreeDifference ||
          left.label.localeCompare(right.label, 'zh-CN')
        )
      })
      .slice(0, keyNodeCount)
      .map((node) => node.id)
  )
  const reducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const showEdgeLabels =
    nodes.length <= 18 && relations.length <= 24

  return {
    animation: !reducedMotion,
    animationDuration: 220,
    animationDurationUpdate: 160,
    tooltip: {
      trigger: 'item',
      renderMode: 'richText',
      backgroundColor: surfaceRaised,
      borderColor: borderDefault,
      textStyle: { color: textPrimary },
      formatter: (params: {
        dataType?: string
        data?: { name?: string; type?: string; value?: string }
      }) => {
        if (params.dataType === 'edge') {
          return params.data?.value ?? '关系'
        }
        return [params.data?.name, params.data?.type]
          .filter(Boolean)
          .join(' · ')
      }
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        zoom,
        scaleLimit: {
          min: 0.5,
          max: 2
        },
        force: {
          repulsion: dense
            ? Math.min(480, 220 + nodes.length * 2)
            : 200,
          gravity: 0.06,
          edgeLength: dense ? [70, 130] : [90, 150],
          friction: 0.08,
          layoutAnimation: !reducedMotion
        },
        selectedMode: 'single',
        symbol: 'circle',
        categories: [...typeStyles.entries()].map(([name, style]) => ({
          name,
          itemStyle: style
        })),
        data: nodes.map((node) => {
          const selected = node.id === selectedNodeId
          const typeStyle = typeStyles.get(node.type) ?? {
            color: accentSubtle,
            borderColor: accent
          }
          const degree = degreeByNodeId.get(node.id) ?? 0
          const degreeRatio = Math.sqrt(degree / maximumDegree)
          const symbolSize = dense
            ? 16 + degreeRatio * 16
            : 32 + degreeRatio * 16
          const showLabel = !dense || keyNodeIds.has(node.id)
          return {
            id: node.id,
            name: node.label,
            type: node.type,
            value: degree,
            category: node.type,
            x: node.x,
            y: node.y,
            draggable: true,
            selected,
            symbolSize: selected ? symbolSize + 4 : symbolSize,
            itemStyle: {
              color: typeStyle.color,
              borderColor: selected ? accent : typeStyle.borderColor,
              borderWidth: selected ? 2.5 : 1.5
            },
            label: {
              show: showLabel || selected,
              color: textPrimary,
              fontSize: dense ? 11 : 12,
              fontWeight: keyNodeIds.has(node.id) ? 650 : 500,
              position: dense ? 'right' : 'inside',
              distance: dense ? 5 : 0,
              formatter:
                node.label.length > 8
                  ? `${node.label.slice(0, 8)}…`
                  : node.label
            },
            emphasis: {
              focus: 'adjacency',
              itemStyle: {
                borderColor: accent,
                borderWidth: 2.5
              },
              label: {
                show: true
              }
            },
            select: {
              itemStyle: {
                color: typeStyle.color,
                borderColor: accent,
                borderWidth: 2.5
              },
              label: {
                show: true
              }
            }
          }
        }),
        links: relations.map((relation) => ({
          id: relation.id,
          source: relation.sourceId,
          target: relation.targetId,
          value: relation.type,
          description: relation.description,
          lineStyle: {
            color: borderDefault,
            width: 1.2,
            opacity: 0.72,
            curveness: 0.06
          }
        })),
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 6,
        edgeLabel: {
          show: showEdgeLabels,
          color: textSecondary,
          fontSize: 11,
          formatter: (params: { data?: { value?: string } }) =>
            params.data?.value ?? ''
        },
        lineStyle: {
          color: textMuted
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: {
            width: 3
          }
        }
      }
    ]
  }
}

export function KnowledgeGraphChart({
  nodes,
  relations,
  selectedNodeId,
  zoom,
  onMoveNode,
  onSelectNode,
  onZoomChange
}: KnowledgeGraphChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ECharts | null>(null)
  const onMoveNodeRef = useRef(onMoveNode)
  const onSelectNodeRef = useRef(onSelectNode)
  const onZoomChangeRef = useRef(onZoomChange)
  const nodesRef = useRef(nodes)
  const relationsRef = useRef(relations)
  const dragRef = useRef<NodeDrag | undefined>(undefined)
  const viewportRef = useRef<GraphViewport>({})
  const zoomRef = useRef(zoom)
  const appliedZoomRef = useRef<number | undefined>(undefined)
  const dataRevision = useMemo(
    () => graphRevision(nodes, relations),
    [nodes, relations]
  )
  const [themeRevision, setThemeRevision] = useState(0)

  useEffect(() => {
    nodesRef.current = nodes
    relationsRef.current = relations
  }, [nodes, relations])

  useEffect(() => {
    onMoveNodeRef.current = onMoveNode
    onSelectNodeRef.current = onSelectNode
    onZoomChangeRef.current = onZoomChange
  }, [onMoveNode, onSelectNode, onZoomChange])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    if (typeof MutationObserver !== 'function') {
      return
    }
    const observer = new MutationObserver(() => {
      setThemeRevision((revision) => revision + 1)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    const chart = init(container, undefined, { renderer: 'canvas' })
    chartRef.current = chart

    const selectNode = (event: ECElementEvent): void => {
      const data = event.data as { id?: unknown } | undefined
      if (event.dataType === 'node' && typeof data?.id === 'string') {
        onSelectNodeRef.current(data.id)
      }
    }
    const beginNodeDrag = (event: ECElementEvent): void => {
      const data = event.data as { id?: unknown } | undefined
      const pointerEvent = event.event
      if (
        event.dataType !== 'node' ||
        typeof data?.id !== 'string' ||
        !pointerEvent ||
        !Number.isFinite(pointerEvent.offsetX) ||
        !Number.isFinite(pointerEvent.offsetY)
      ) {
        return
      }
      const pointer = chart.convertFromPixel(
        { seriesIndex: 0 },
        [pointerEvent.offsetX, pointerEvent.offsetY]
      )
      const centerPixel =
        pointerEvent.target?.transformCoordToGlobal(0, 0)
      const center = centerPixel
        ? chart.convertFromPixel(
            { seriesIndex: 0 },
            centerPixel
          )
        : undefined
      if (
        Array.isArray(pointer) &&
        Number.isFinite(pointer[0]) &&
        Number.isFinite(pointer[1]) &&
        Array.isArray(center) &&
        Number.isFinite(center[0]) &&
        Number.isFinite(center[1])
      ) {
        dragRef.current = {
          id: data.id,
          pointerX: Number(pointer[0]),
          pointerY: Number(pointer[1]),
          x: Number(center[0]),
          y: Number(center[1])
        }
      }
    }
    const persistNodePosition = (event: ECElementEvent): void => {
      const drag = dragRef.current
      dragRef.current = undefined
      const pointerEvent = event.event
      if (
        !drag ||
        !pointerEvent ||
        !Number.isFinite(pointerEvent.offsetX) ||
        !Number.isFinite(pointerEvent.offsetY)
      ) {
        return
      }
      const pointer = chart.convertFromPixel(
        { seriesIndex: 0 },
        [pointerEvent.offsetX, pointerEvent.offsetY]
      )
      if (
        !Array.isArray(pointer) ||
        !Number.isFinite(pointer[0]) ||
        !Number.isFinite(pointer[1])
      ) {
        return
      }
      const deltaX = Number(pointer[0]) - drag.pointerX
      const deltaY = Number(pointer[1]) - drag.pointerY
      if (Math.hypot(deltaX, deltaY) < 2) {
        return
      }
      onMoveNodeRef.current(drag.id, {
        x: drag.x + deltaX,
        y: drag.y + deltaY
      })
    }
    const persistViewport = (): void => {
      const option = chart.getOption()
      const series = Array.isArray(option.series)
        ? option.series[0]
        : option.series
      if (!series || typeof series !== 'object') {
        return
      }
      const nextViewport: GraphViewport = {}
      if (
        'center' in series &&
        Array.isArray(series.center) &&
        series.center.length === 2 &&
        series.center.every(
          (value: unknown) =>
            typeof value === 'number' || typeof value === 'string'
        )
      ) {
        nextViewport.center = [
          series.center[0] as number | string,
          series.center[1] as number | string
        ]
      }
      if (
        'zoom' in series &&
        typeof series.zoom === 'number' &&
        Number.isFinite(series.zoom)
      ) {
        if (Math.abs(series.zoom - zoomRef.current) >= 0.001) {
          zoomRef.current = series.zoom
          appliedZoomRef.current = series.zoom
          onZoomChangeRef.current(series.zoom)
        }
      }
      viewportRef.current = nextViewport
    }
    const resize = (): void => chart.resize()

    chart.on('click', selectNode)
    chart.on('mousedown', beginNodeDrag)
    chart.on('mouseup', persistNodePosition)
    chart.on('graphRoam', persistViewport)

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(container)
    } else {
      window.addEventListener('resize', resize)
    }

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resize)
      chart.off('click', selectNode)
      chart.off('mousedown', beginNodeDrag)
      chart.off('mouseup', persistNodePosition)
      chart.off('graphRoam', persistViewport)
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) {
      return
    }
    const option = createOption({
      nodes: nodesRef.current,
      relations: relationsRef.current,
      selectedNodeId: undefined,
      zoom: zoomRef.current
    })
    const series = Array.isArray(option.series)
      ? option.series[0]
      : option.series
    if (
      series &&
      typeof series === 'object' &&
      viewportRef.current.center
    ) {
      series.center = viewportRef.current.center
    }
    chart.setOption(
      option,
      { notMerge: true }
    )
    appliedZoomRef.current = zoomRef.current
  }, [dataRevision, themeRevision])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) {
      return
    }
    if (
      appliedZoomRef.current !== undefined &&
      Math.abs(appliedZoomRef.current - zoom) < 0.001
    ) {
      return
    }
    chart.setOption({
      series: [{ zoom }]
    })
    appliedZoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) {
      return
    }
    chart.dispatchAction({
      type: 'unselect',
      seriesIndex: 0
    })
    const dataIndex = selectedNodeId
      ? nodesRef.current.findIndex((node) => node.id === selectedNodeId)
      : -1
    if (dataIndex >= 0) {
      chart.dispatchAction({
        type: 'select',
        seriesIndex: 0,
        dataIndex
      })
    }
  }, [dataRevision, selectedNodeId, themeRevision])

  return (
    <div
      aria-label="实体关系图"
      className="knowledge-graph__chart"
      ref={containerRef}
      role="img"
    />
  )
}
