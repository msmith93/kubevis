import { useEffect, useRef, useState } from 'react'
import { routeRequest } from './cluster'
import { TRAFFIC_TICK_MS, REQ_FLIGHT_TTL_MS } from './timing'
import {
  CRASH_BACKOFF_MAX_MS,
  CRASH_BACKOFF_MS,
  CRASH_STREAK_RESET_MS,
  DEFAULT_RPS_INDEX,
  OVERLOAD_GRACE_MS,
  OVERLOAD_JITTER_MS,
  POD_CAPACITY_RPS,
  RESTART_CREATING_MS,
  RPS_STEPS,
} from './constants'

// The ambient traffic layer, entirely OUTSIDE the op machinery. A slider sets
// the synthetic request rate (RPS_STEPS; 0 = paused); a fixed 250ms tick
// accumulates fractional requests (rps × dt) and evaluates routeRequest
// against the currently RENDERED (derived) cluster — so traffic reacts live
// to mid-op states and stepper scrubbing. At rps ≤ 1 each request flies as an
// individual chip ('chips' mode); above that the chips would swarm, so the
// layer switches to 'aggregate' mode: no flights, just per-pod loads and
// EMA-smoothed ok/fail rates for the beam overlay and pod badges.
//
// Capacity: a pod serves POD_CAPACITY_RPS. Sustained overload OOM-kills it
// into CrashLoopBackOff via the sanctioned `commit` path (the only writes the
// traffic layer ever makes to committed state); the kubelet restarts it after
// an escalating backoff. Endpoints exclude non-Running pods, so survivors
// inherit a dead pod's share — cascading collapse emerges with no extra code.
// All overload bookkeeping lives in refs here, never in cluster state.

// Deterministic per-pod jitter so a fleet overloaded in unison still dies one
// by one (a visible cascade) instead of all on the same tick.
function podJitter(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % OVERLOAD_JITTER_MS
}

export function useTraffic(cluster, { commit, canStartNew }) {
  const [rpsIndex, setRpsIndex] = useState(DEFAULT_RPS_INDEX)
  const [stats, setStats] = useState({ ok: 0, fail: 0 })
  const [recent, setRecent] = useState([]) // last 8 outcomes (chips mode)
  const [flights, setFlights] = useState([])
  const [live, setLive] = useState({ rates: { ok: 0, fail: 0 }, podLoads: {} })

  const rr = useRef(0) // round-robin cursor across endpoints
  const seq = useRef(0)
  const carry = useRef(0) // fractional-request accumulator
  const ema = useRef({ ok: 0, fail: 0 })
  // Overload book: podName -> { state: 'hot'|'backoff'|'starting'|'cooling',
  //   overSince, jitter, streak, backoffUntil, startingUntil, coolUntil }.
  // 'cooling' carries the crash streak briefly after a recovery so a pod that
  // immediately re-overloads keeps its doubled backoff.
  const book = useRef(new Map())
  // The tick closure reads the latest values through refs so the single timer
  // survives slider changes and derived-cluster updates.
  const clusterRef = useRef(cluster)
  clusterRef.current = cluster
  const canStartNewRef = useRef(canStartNew)
  canStartNewRef.current = canStartNew
  const rpsRef = useRef(RPS_STEPS[rpsIndex])
  rpsRef.current = RPS_STEPS[rpsIndex]

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now()
      const rps = rpsRef.current
      const dt = TRAFFIC_TICK_MS / 1000
      const c = clusterRef.current

      // 1 · GC book entries whose pod no longer exists (reset, delete, drain).
      for (const name of [...book.current.keys()])
        if (!c.pods[name]) book.current.delete(name)

      // 2 · Restart machine — runs even at rps 0: recovery must not depend on
      // traffic still flowing. Guards live in the mutators (they see the
      // committed clone), so an op that re-phased the pod makes them no-ops.
      for (const [name, entry] of book.current) {
        if (entry.state === 'backoff' && now >= entry.backoffUntil) {
          book.current.set(name, {
            ...entry,
            state: 'starting',
            startingUntil: now + RESTART_CREATING_MS,
          })
          commit((cc) => {
            const p = cc.pods[name]
            if (p && p.phase === 'CrashLoopBackOff')
              cc.pods[name] = { ...p, phase: 'ContainerCreating' }
          })
        } else if (entry.state === 'starting' && now >= entry.startingUntil) {
          book.current.set(name, {
            state: 'cooling',
            streak: entry.streak,
            coolUntil: now + CRASH_STREAK_RESET_MS,
          })
          commit((cc) => {
            const p = cc.pods[name]
            if (p && p.phase === 'ContainerCreating') {
              cc.pods[name] = { ...p, phase: 'Running', restarts: p.restarts + 1 }
              cc.events.push({
                id: `traffic-${seq.current++}`,
                type: 'Normal',
                reason: 'Started',
                obj: `pod/${name}`,
                message: 'Started container (restart)',
              })
            }
          })
        } else if (entry.state === 'cooling' && now >= entry.coolUntil) {
          book.current.delete(name) // streak forgiven after a healthy stretch
        }
      }

      // 3 · Route once and compute per-pod load (round-robin spreads the rate
      // evenly, so load = serviceRPS / readyEndpoints).
      const route = routeRequest(c)
      const endpoints = route.outcome === 'ok' ? route.endpoints : []
      const load = rps > 0 && endpoints.length > 0 ? rps / endpoints.length : 0
      const podLoads = {}
      for (const ep of endpoints) podLoads[ep.name] = load

      // 4 · Hot tracking. Over capacity starts (or continues) the grace clock;
      // back under capacity clears it (keeping the streak if one is cooling).
      const hot = load > POD_CAPACITY_RPS
      for (const ep of endpoints) {
        const entry = book.current.get(ep.name)
        if (hot) {
          if (!entry || entry.state === 'cooling')
            book.current.set(ep.name, {
              state: 'hot',
              overSince: now,
              jitter: podJitter(ep.name),
              streak: entry?.streak ?? 0,
            })
        } else if (entry?.state === 'hot') {
          if (entry.streak > 0)
            book.current.set(ep.name, {
              state: 'cooling',
              streak: entry.streak,
              coolUntil: now + CRASH_STREAK_RESET_MS,
            })
          else book.current.delete(ep.name)
        }
      }

      // 5 · Crash commit — deferred while an op is mid-walk (the op is a
      // narrated story; the pressure persists, so the crash lands on the first
      // tick after it completes), and at most one pod per tick so simultaneous
      // overloads die as a visible cascade.
      if (canStartNewRef.current) {
        let victim = null
        for (const [name, entry] of book.current) {
          if (entry.state !== 'hot') continue
          if (now - entry.overSince < OVERLOAD_GRACE_MS + entry.jitter) continue
          if (!victim || entry.overSince < book.current.get(victim).overSince)
            victim = name
        }
        if (victim) {
          const entry = book.current.get(victim)
          book.current.set(victim, {
            state: 'backoff',
            streak: entry.streak + 1,
            backoffUntil:
              now +
              Math.min(CRASH_BACKOFF_MS * 2 ** entry.streak, CRASH_BACKOFF_MAX_MS),
          })
          commit((cc) => {
            const p = cc.pods[victim]
            if (p && p.phase === 'Running') {
              cc.pods[victim] = { ...p, phase: 'CrashLoopBackOff' }
              cc.events.push(
                {
                  id: `traffic-${seq.current++}`,
                  type: 'Warning',
                  reason: 'OOMKilled',
                  obj: `pod/${victim}`,
                  message: `Container exceeded its ${POD_CAPACITY_RPS} r/s capacity and was OOM-killed`,
                },
                {
                  id: `traffic-${seq.current++}`,
                  type: 'Warning',
                  reason: 'BackOff',
                  obj: `pod/${victim}`,
                  message: 'Back-off restarting failed container',
                },
              )
            }
          })
        }
      }

      // 6 · Emit this tick's requests. Chips mode spawns one decorative flight
      // per request (n is 0 or 1 at rps ≤ 1); aggregate mode only moves the
      // counters and the EMA rates the beams/badges render from.
      const aggregate = rps > 1
      if (rps > 0) {
        carry.current += rps * dt
        const n = Math.floor(carry.current)
        carry.current -= n
        if (n > 0) {
          setStats((s) =>
            route.outcome === 'ok'
              ? { ...s, ok: s.ok + n }
              : { ...s, fail: s.fail + n },
          )
          if (!aggregate) {
            let podName = null
            let nodeId = null
            if (route.outcome === 'ok') {
              const ep = endpoints[rr.current++ % endpoints.length]
              podName = ep.name
              nodeId = ep.node
            }
            const flight = {
              id: `req-${seq.current++}`,
              outcome: route.outcome,
              podName,
              nodeId,
              svcName: route.service?.name ?? route.ingress?.serviceName ?? null,
            }
            setFlights((fs) => [...fs, flight])
            setTimeout(
              () => setFlights((fs) => fs.filter((f) => f.id !== flight.id)),
              REQ_FLIGHT_TTL_MS,
            )
            setRecent((r) => [...r.slice(-7), route.outcome])
          }
        }
        // EMA over the instantaneous per-tick rate (n/dt), including n = 0
        // ticks, so displayed rates settle on the true rps instead of pulsing.
        const inst = n / dt
        ema.current = {
          ok: ema.current.ok * 0.7 + (route.outcome === 'ok' ? inst : 0) * 0.3,
          fail: ema.current.fail * 0.7 + (route.outcome !== 'ok' ? inst : 0) * 0.3,
        }
      } else {
        carry.current = 0
        ema.current = { ok: 0, fail: 0 }
      }

      // 7 · Publish at most one state update per tick, skipped in steady state
      // so an idle app stops re-rendering.
      const rates = {
        ok: Math.round(ema.current.ok * 10) / 10,
        fail: Math.round(ema.current.fail * 10) / 10,
      }
      setLive((prev) => {
        const sameRates =
          prev.rates.ok === rates.ok && prev.rates.fail === rates.fail
        const prevKeys = Object.keys(prev.podLoads)
        const nextKeys = Object.keys(podLoads)
        const sameLoads =
          prevKeys.length === nextKeys.length &&
          nextKeys.every(
            (k) => Math.round(prev.podLoads[k] ?? -1) === Math.round(podLoads[k]),
          )
        return sameRates && sameLoads ? prev : { rates, podLoads }
      })
    }, TRAFFIC_TICK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rps = RPS_STEPS[rpsIndex]
  return {
    rps,
    rpsIndex,
    setRpsIndex,
    mode: rps > 1 ? 'aggregate' : 'chips',
    stats,
    rates: live.rates,
    podLoads: live.podLoads,
    recent,
    flights,
  }
}
