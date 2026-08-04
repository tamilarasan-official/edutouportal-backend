import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { verifyAccessToken } from '../auth/tokens.js'
import { ACCESS_COOKIE } from '../middleware/auth.js'

/**
 * Realtime hub. Replaces Supabase Realtime.
 *
 * The frontend used two distinct features:
 *   1. `postgres_changes` subscriptions on session_participants, quiz_sessions
 *      and session_answers -- i.e. "tell me when a row changes".
 *   2. broadcast channels for lobby/quiz events.
 *
 * Both collapse into one model here: named channels carrying JSON events. The
 * server publishes a change event at the point it performs the write, which is
 * more reliable than replicating the WAL and needs no Postgres configuration.
 * (The old setup broke whenever someone forgot to tick "Enable Realtime" on a
 * table in the dashboard -- realtime.ts even logged instructions for it.)
 */

export interface RealtimeEvent {
  readonly channel: string
  readonly event: string
  readonly payload: unknown
}

interface Client {
  readonly socket: WebSocket
  readonly userId: string
  readonly channels: Set<string>
  isAlive: boolean
}

const clients = new Set<Client>()

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

/**
 * Channel names the client may subscribe to. Anything else is rejected --
 * without this, a client could subscribe to a channel name it guessed and
 * receive events meant for another session.
 */
const CHANNEL_PATTERN = /^(session|participants|answers|lobby|table):[A-Za-z0-9_-]{1,64}$/

export function publish(channel: string, event: string, payload: unknown): void {
  const message = JSON.stringify({ channel, event, payload })

  for (const client of clients) {
    if (!client.channels.has(channel)) continue
    if (client.socket.readyState !== WebSocket.OPEN) continue
    client.socket.send(message)
  }
}

/**
 * Publish to a specific set of users only.
 *
 * Needed for table-level channels: under Supabase Realtime, a `postgres_changes`
 * subscription with RLS unwritten delivered every inserted row to every
 * subscriber, and the browser filtered afterwards -- so students received
 * notifications addressed to other mentors' students. Computing the recipient
 * set at publish time keeps that data off the wire entirely.
 */
export function publishTo(
  recipients: ReadonlySet<string>,
  channel: string,
  event: string,
  payload: unknown
): void {
  if (recipients.size === 0) return
  const message = JSON.stringify({ channel, event, payload })

  for (const client of clients) {
    if (!client.channels.has(channel)) continue
    if (!recipients.has(client.userId)) continue
    if (client.socket.readyState !== WebSocket.OPEN) continue
    client.socket.send(message)
  }
}

/** Convenience wrapper matching the old postgres_changes payload shape. */
export function publishChange(
  channel: string,
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  row: unknown,
  old?: unknown
): void {
  publish(channel, 'postgres_changes', {
    eventType,
    new: eventType === 'DELETE' ? {} : row,
    old: old ?? {},
  })
}

export function attachRealtime(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/realtime' })

  wss.on('connection', async (socket, request) => {
    // Authenticate from the same httpOnly cookie the REST API uses. There is
    // no token in the URL, so it cannot leak via logs or Referer headers.
    const cookies = parseCookies(request.headers.cookie)
    const token = cookies[ACCESS_COOKIE]
    const claims = token ? await verifyAccessToken(token) : null

    if (!claims) {
      socket.close(4401, 'Unauthenticated')
      return
    }

    const client: Client = {
      socket,
      userId: claims.sub,
      channels: new Set<string>(),
      isAlive: true,
    }
    clients.add(client)

    socket.on('pong', () => {
      client.isAlive = true
    })

    socket.on('message', (raw) => {
      let message: { type?: string; channel?: string }
      try {
        message = JSON.parse(String(raw)) as typeof message
      } catch {
        return
      }

      const channel = message.channel
      if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid channel' }))
        return
      }

      if (message.type === 'subscribe') {
        // Cap subscriptions so one socket cannot fan out unboundedly.
        if (client.channels.size >= 20) {
          socket.send(JSON.stringify({ type: 'error', message: 'Too many subscriptions' }))
          return
        }
        client.channels.add(channel)
        socket.send(JSON.stringify({ type: 'subscribed', channel }))
        return
      }

      if (message.type === 'unsubscribe') {
        client.channels.delete(channel)
        socket.send(JSON.stringify({ type: 'unsubscribed', channel }))
      }
    })

    socket.on('close', () => {
      clients.delete(client)
    })

    socket.on('error', () => {
      clients.delete(client)
    })

    socket.send(JSON.stringify({ type: 'ready' }))
  })

  // Drop sockets that stop responding, so `clients` cannot grow without bound
  // behind a proxy that never signals close.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        client.socket.terminate()
        clients.delete(client)
        continue
      }
      client.isAlive = false
      client.socket.ping()
    }
  }, 30_000)

  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

export function connectedClientCount(): number {
  return clients.size
}
