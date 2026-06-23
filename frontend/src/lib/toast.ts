// Tiny module-level toast store (pub/sub) so non-component code — e.g. the
// React Query MutationCache onError handler — can surface a message without
// threading a context through every hook. <Toaster /> subscribes and renders.

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

type Listener = (toasts: Toast[]) => void

let toasts: Toast[] = []
let seq = 0
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l(toasts)
}

export const toast = {
  show(message: string, kind: ToastKind = 'info', ttlMs = 5000): number {
    const id = ++seq
    toasts = [...toasts, { id, kind, message }]
    emit()
    if (ttlMs > 0) setTimeout(() => toast.dismiss(id), ttlMs)
    return id
  },
  dismiss(id: number) {
    toasts = toasts.filter((t) => t.id !== id)
    emit()
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    fn(toasts)
    return () => listeners.delete(fn)
  },
}
