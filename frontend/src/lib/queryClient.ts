import { MutationCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/http'
import { toast } from '@/lib/toast'

// Centralized mutation error handling: a 409 means someone else edited the same
// record first (optimistic-lock conflict). Tell the user plainly — the affected
// hooks refetch so the latest value is shown — instead of silently losing the edit.
const mutationCache = new MutationCache({
  onError: (err) => {
    if (!(err instanceof ApiError)) return
    if (err.status === 409) {
      // Version conflicts carry `current` (the latest record); other 409s (e.g.
      // duplicate key) just carry a detail message.
      toast.show(
        err.current
          ? '他の人が先に更新しました。最新の内容に更新しましたので、もう一度お試しください。'
          : err.message,
        'warn',
      )
    }
  },
})

export const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
