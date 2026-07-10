// Demo-size caps shared by the kubectl parser (validation), the scheduler
// stand-in, and the stage layout so the cluster never overflows the screen.

export const MAX_REPLICAS = 6 // per deployment, enforced by the parser
export const MAX_PODS_PER_NODE = 4 // stage rows per node column
export const MAX_TOTAL_PODS = 12 // 3 workers x MAX_PODS_PER_NODE

export const EVENTS_SHOWN = 12 // rows in `kubectl get events` and the inspector

// ---- synthetic traffic / pod capacity ---------------------------------------
// A pod serves up to POD_CAPACITY_RPS; sustained overload (the grace period,
// plus a per-pod jitter so simultaneous overloads cascade instead of dying in
// unison) gets it OOM-killed into CrashLoopBackOff. The kubelet retries after
// an escalating backoff; a stretch of healthy running resets the escalation.
export const POD_CAPACITY_RPS = 20
export const RPS_STEPS = [0, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 50, 75, 100]
export const DEFAULT_RPS_INDEX = 1 // 0.2 r/s — one request every 5s
export const OVERLOAD_GRACE_MS = 3000
export const OVERLOAD_JITTER_MS = 1200
export const CRASH_BACKOFF_MS = 5000 // first restart backoff; doubles per streak
export const CRASH_BACKOFF_MAX_MS = 20000
export const RESTART_CREATING_MS = 1200 // ContainerCreating dwell on kubelet restart
export const CRASH_STREAK_RESET_MS = 10000
