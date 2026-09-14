/**
 * React bindings for the window's speaker: live speaking state for buttons, and auto-read of replies
 * that finish in the open thread.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { resolveSpeechSettings } from '@shared/speech'
import { useStore } from '@/state/store'
import { newlyFinishedReplies } from './autoRead'
import { getSpeaker, setSpeakerErrorSink, type SpeakerState, type SpeakerStatus } from './speaker'

/**
 * This message's speaking status. Returns a primitive, so in a long thread only the reply whose
 * status changed re-renders, not every memoized turn.
 */
const subscribe = (onChange: () => void): (() => void) => getSpeaker().subscribe(onChange)

export function useSpeakingStatus(id: string): SpeakerStatus {
  const read = (): SpeakerStatus => {
    const state = getSpeaker().getState()
    return state.id === id ? state.status : 'idle'
  }
  return useSyncExternalStore(subscribe, read, read)
}

export function useSpeakerState(): SpeakerState {
  const read = (): SpeakerState => getSpeaker().getState()
  return useSyncExternalStore(subscribe, read, read)
}

/** Mount once at the app root: routes speaker errors to toasts and reads finished replies aloud. */
export function useSpeechRuntime(): void {
  useEffect(() => {
    setSpeakerErrorSink((message) => useStore.getState().flash(message, 'warn'))
    let previous = useStore.getState().messages
    let previousThread = useStore.getState().activeThreadId
    return useStore.subscribe((state) => {
      const { messages, activeThreadId, settings } = state
      if (messages === previous && activeThreadId === previousThread) return
      const sameThread = activeThreadId === previousThread
      const finished = sameThread ? newlyFinishedReplies(previous, messages) : []
      previous = messages
      previousThread = activeThreadId
      const speech = resolveSpeechSettings(settings?.speech)
      const reply = finished.at(-1)
      if (speech.autoRead && reply) void getSpeaker().speak(reply.id, reply.text, speech)
    })
  }, [])
}
