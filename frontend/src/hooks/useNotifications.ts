// In-app notifications (ベル). Polls every 60s (cron-free server: the GET also
// mints any 未入力 reminders the user has earned). Mark-read mutations refresh.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '@/api/client'

const POLL_MS = 60_000

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: api.getNotifications,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
}
