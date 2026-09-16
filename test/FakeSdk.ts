import type * as Pi from "@earendil-works/pi-coding-agent"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"

import * as Adapter from "../src/internal/Pi.js"
import * as Session from "../src/Session.js"

/** Promise gates live only at the simulated SDK boundary. Tests await them as Effects. */
export const gate = () => {
  let resolve = (): void => {}
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve, wait: Effect.promise(() => promise), open: Effect.sync(resolve) }
}

type Assistant = Extract<Pi.SessionMessageEntry["message"], { readonly role: "assistant" }>
export const assistant = (text: string, stopReason: Assistant["stopReason"] = "stop"): Assistant => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "test",
  model: "test",
  stopReason,
  timestamp: 0,
  usage: {
    input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 }
  }
})

interface Options {
  readonly acquire?: () => Promise<void>
  readonly preflight?: () => Promise<void>
  readonly prompt?: (context: {
    readonly text: string
    readonly manager: Pi.SessionManager
    readonly emit: (event: Pi.AgentSessionEvent) => void
  }) => Promise<void>
  readonly abort?: () => void
  readonly abortCompaction?: () => void
  readonly dispose?: () => void
}

export const make = Effect.fnUntraced(function* (options: Options = {}) {
  const fs = yield* FileSystem.FileSystem
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "effect-pi-test-" })
  const id = Schema.decodeUnknownSync(Session.Id)("sdk-test")
  const factoryStarted = gate()
  const promptStarted = gate()
  const abortRequested = gate()
  const listeners = new Set<Pi.AgentSessionEventListener>()
  const calls: Array<string> = []
  const lifecycle: Array<string> = []
  let streaming = false
  let abortCount = 0
  let sessionDirectory = ""
  const emit = (event: Pi.AgentSessionEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const create: Adapter.CreateSession = async ({ sessionManager: manager }) => {
    sessionDirectory = manager.getSessionDir()
    factoryStarted.resolve()
    await options.acquire?.()
    return {
      session: {
        get messages() { return manager.buildSessionContext().messages },
        get isStreaming() { return streaming },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener); lifecycle.push("unsubscribe") }
        },
        prompt: async (text) => {
          calls.push(text)
          await options.preflight?.()
          streaming = true
          promptStarted.resolve()
          emit({ type: "agent_start" })
          manager.appendMessage({ role: "user", content: text, timestamp: 0 })
          try {
            if (options.prompt !== undefined) {
              await options.prompt({ text, manager, emit })
            } else {
              manager.appendMessage(assistant(text))
            }
          } finally {
            streaming = false
            lifecycle.push("settled")
            emit({ type: "agent_settled" })
          }
        },
        agent: { abort: () => {
          abortCount++
          abortRequested.resolve()
          if (streaming) options.abort?.()
        } },
        abortRetry: () => {},
        abortCompaction: () => { options.abortCompaction?.() },
        abortBranchSummary: () => {},
        abortBash: () => {},
        dispose: () => { lifecycle.push("dispose"); options.dispose?.() }
      }
    }
  }
  return {
    id,
    cwd,
    create,
    session: Adapter.makeWith({ id, cwd }, create),
    factoryStarted,
    promptStarted,
    abortRequested,
    calls,
    lifecycle,
    emit,
    get abortCount() { return abortCount },
    get sessionDirectory() { return sessionDirectory },
    get listenerCount() { return listeners.size }
  }
})
