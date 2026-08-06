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
import { useEffect, useRef, useState } from 'react'
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
  const accentSelected = readToken('--accent-selected')
  const accentSubtle = readToken('--accent-subtle')
  const surfaceRaised = readToken('--surface-raised')
  const borderDefault = readToken('--border-default')
  const dense = nodes.length > 24
  const veryDense = nodes.length > 60
  const showEdgeLabels =
    nodes.length <= 18 && relations.length <= 24

  return {
    animation: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
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
            ? Math.min(520, 130 + nodes.length * 3)
            : 220,
          gravity: dense ? 0.14 : 0.08,
          edgeLength: dense
            ? veryDense
              ? [45, 80]
              : [60, 110]
            : [110, 190],
          friction: dense ? 0.5 : 0.6,
          layoutAnimation:
            !window.matchMedia?.('(prefers-reduced-motion: reduce)')
              .matches
        },
        selectedMode: 'single',
        symbol: 'circle',
        data: nodes.map((node) => {
          const selected = node.id === selectedNodeId
          return {
            id: node.id,
            name: node.label,
            type: node.type,
            ...(dense ? {} : { x: node.x, y: node.y }),
            draggable: true,
            selected,
            symbolSize: selected
              ? dense
                ? 34
                : 60
              : dense
                ? veryDense
                  ? 18
                  : 24
                : 52,
            itemStyle: {
              color: selected ? accentSelected : accentSubtle,
              borderColor: accent,
              borderWidth: selected ? 3 : 2
            },
            label: {
              show: !dense || selected,
              color: textPrimary,
              fontSize: dense ? 11 : 12,
              fontWeight: 700,
              formatter:
                node.label.length > 8
                  ? `${node.label.slice(0, 8)}…`
                  : node.label
            },
            emphasis: {
              focus: 'adjacency',
              label: {
                show: true
              }
            },
            select: {
              itemStyle: {
                color: accentSelected,
                borderColor: accent,
                borderWidth: 3
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
            color: textMuted,
            width: 1.5,
            curveness: 0.08
          }
        })),
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 8,
        autoCurveness: true,
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
  const dragRef = useRef<NodeDrag | undefined>(undefined)
  const viewportRef = useRef<GraphViewport>({})
  const zoomRef = useRef(zoom)
  const appliedZoomRef = useRef<number | undefined>(undefined)
  const [themeRevision, setThemeRevision] = useState(0)

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
      nodes,
      relations,
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
  }, [nodes, relations, themeRevision])

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
      ? nodes.findIndex((node) => node.id === selectedNodeId)
      : -1
    if (dataIndex >= 0) {
      chart.dispatchAction({
        type: 'select',
        seriesIndex: 0,
        dataIndex
      })
    }
  }, [nodes, selectedNodeId, themeRevision])

  return (
    <div
      aria-label="实体关系图"
      className="knowledge-graph__chart"
      ref={containerRef}
      role="img"
    />
  )
}
