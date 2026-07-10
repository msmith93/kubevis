import { useEffect, useState } from 'react'
import { routeRequest } from '../cluster'
import { selectorRect } from './ChipFlight'
import { TRAFFIC_TICK_MS } from '../timing'

// Aggregate traffic rendering for rps > 1, where per-request chips would
// swarm: a fixed, click-through SVG overlay drawing flow beams down the
// data-plane stack (user → ingress → svc) and fanning out to each serving
// node, width/opacity/dash-speed scaled with the segment's request rate.
// Failed chains are truncated at the failing hop, drawn red with the status
// code — mirroring RequestFlight's hop logic. Anchors are re-measured on a
// tick + window resize, so the beams track layout changes.

const bottomC = (r) => r && { x: r.left + r.width / 2, y: r.bottom }
const topC = (r) => r && { x: r.left + r.width / 2, y: r.top }

function Beam({ from, to, rps, fail, label }) {
  if (!from || !to || rps <= 0) return null
  const width = 1.5 + 2 * Math.log2(1 + rps / 5)
  const opacity = Math.min(0.9, 0.35 + rps / 60)
  const dur = `${(1.6 / (1 + rps / 10)).toFixed(2)}s`
  return (
    <g>
      <line
        className={'beam' + (fail ? ' fail' : '')}
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        strokeWidth={width}
        strokeOpacity={opacity}
        style={{ '--beam-dur': dur }}
      />
      {label && (
        <text className="beam-label" x={to.x + 8} y={to.y + 4}>
          {label}
        </text>
      )}
    </g>
  )
}

export default function TrafficBeams({ cluster, rps, podLoads }) {
  // Self-clocked re-measure: anchors are live DOM rects, and steady-state
  // traffic intentionally stops re-rendering App, so the overlay keeps its
  // own cheap timer (plus resize) to follow layout drift.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), TRAFFIC_TICK_MS)
    const onResize = () => force((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => {
      clearInterval(id)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  if (rps <= 0) return null
  const route = routeRequest(cluster)
  const user = selectorRect('[data-fly="user"]')
  const ingress = selectorRect('[data-fly="ingress"]')
  const svcName = route.service?.name ?? route.ingress?.serviceName ?? null
  const svc = svcName ? selectorRect(`[data-fly="svc-${svcName}"]`) : null

  // Requests concentrate per node: sum the endpoint loads on each one.
  const nodeShares = {}
  for (const [name, load] of Object.entries(podLoads)) {
    const pod = cluster.pods[name]
    if (pod?.node) nodeShares[pod.node] = (nodeShares[pod.node] ?? 0) + load
  }

  const noRule = route.outcome === 'no-rule'
  const noService = route.outcome === 'no-service'
  const noEndpoints = route.outcome === 'no-endpoints'

  return (
    <svg className="beam-layer" width="100%" height="100%">
      <Beam
        from={bottomC(user)}
        to={topC(ingress)}
        rps={rps}
        fail={noRule}
        label={noRule ? '404' : null}
      />
      {/* Rule exists but its Service object doesn't: the chain dies on the
          ingress → service hop, drawn as a short red stub. */}
      {noService && ingress && (
        <Beam
          from={bottomC(ingress)}
          to={{ x: bottomC(ingress).x, y: ingress.bottom + 36 }}
          rps={rps}
          fail
          label="503"
        />
      )}
      {!noRule && !noService && (
        <Beam
          from={bottomC(ingress)}
          to={topC(svc)}
          rps={rps}
          fail={noEndpoints}
          label={noEndpoints ? '503' : null}
        />
      )}
      {Object.entries(nodeShares).map(([nodeId, share]) => (
        <Beam
          key={nodeId}
          from={bottomC(svc)}
          to={topC(selectorRect(`[data-fly="${nodeId}"]`))}
          rps={share}
        />
      ))}
    </svg>
  )
}
