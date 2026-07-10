import { serviceEndpoints } from '../cluster'
import { RPS_STEPS } from '../constants'

// The traffic rail: the data-plane chain — synthetic user, ingress controller
// (always running, with or without rules), one chip per Service — stacked
// vertically in grid column 1, plus the RPS slider that drives the synthetic
// user (0 = paused). Columns 2-4 stay empty on purpose: they are the airspace
// request chips and aggregate beams travel through on their way to the worker
// columns, so the data plane never overlaps the control-plane card below.
// The rail renders from the DERIVED cluster so it scrubs with the stepper,
// while the request ticker itself lives in useTraffic.
export default function TrafficRail({ cluster, traffic, focus }) {
  const ingresses = Object.values(cluster.ingresses)
  const services = Object.values(cluster.services)
  const { stats, recent, rates, rps, rpsIndex, setRpsIndex, mode } = traffic

  return (
    <div className="traffic-rail">
      <div className="rail-stack">
        <div className="rail-controls">
          <span
            className="rail-caption"
            title="user traffic is the data plane — it never passes through the control plane below"
          >
            data plane
          </span>
          <input
            className="rps-slider"
            type="range"
            min={0}
            max={RPS_STEPS.length - 1}
            step={1}
            value={rpsIndex}
            onChange={(e) => setRpsIndex(+e.target.value)}
            aria-label="synthetic request rate"
          />
          <span className="rps-value">{rps === 0 ? 'paused' : `${rps} r/s`}</span>
        </div>

        <div
          className={'rail-box rail-user' + (focus.has('user') ? ' active' : '')}
          data-fly="user"
        >
          <span className="rail-title">👤 user</span>
          <span className="rail-sub">
            {mode === 'chips' ? (
              <span className="ticker">
                {recent.length === 0 && <span className="empty-note">…</span>}
                {recent.map((r, i) => (
                  <span key={i} className={r === 'ok' ? 'tick-ok' : 'tick-fail'}>
                    {r === 'ok' ? '✓' : '✗'}
                  </span>
                ))}
              </span>
            ) : (
              <span className="rate-pair">
                <span className="rate-ok">{rates.ok.toFixed(1)}/s ok</span>
                {' · '}
                <span className="rate-fail">{rates.fail.toFixed(1)}/s fail</span>
              </span>
            )}
            <span className="counts">
              {stats.ok} ok · {stats.fail} failed
            </span>
          </span>
        </div>

        <span className="rail-arrow down">↓</span>

        <div
          className={'rail-box rail-ingress' + (focus.has('ingress') ? ' active' : '')}
          data-fly="ingress"
        >
          <span className="rail-title">ingress controller</span>
          <span className="rail-sub">
            {ingresses.length === 0 ? (
              <span className="rail-warn">no rules · answers 404</span>
            ) : (
              ingresses.map((i) => (
                <span key={i.name} className="rail-rule">
                  {i.host} → {i.serviceName}:{i.servicePort}
                </span>
              ))
            )}
          </span>
        </div>

        <span className="rail-arrow down">↓</span>

        {services.length === 0 ? (
          <div className="rail-box rail-empty">
            <span className="rail-title">no services</span>
            <span className="rail-sub">
              <span className="rail-warn">kubectl expose deployment …</span>
            </span>
          </div>
        ) : (
          services.map((s) => {
            const eps = serviceEndpoints(cluster, s).length
            return (
              <div
                key={s.name}
                className={
                  'rail-box rail-svc' + (focus.has(`svc:${s.name}`) ? ' active' : '')
                }
                data-fly={`svc-${s.name}`}
              >
                <span className="rail-title">svc/{s.name}</span>
                <span className="rail-sub">
                  {s.clusterIP} ·{' '}
                  <span className={eps === 0 ? 'rail-warn' : 'rail-good'}>
                    endpoints: {eps}
                  </span>
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
