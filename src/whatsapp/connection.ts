import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
  type WASocket,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { query, queryOne } from '../db/pool.js'
import { startSenderLoop, type WhatsAppTransport } from './sender.js'

/**
 * The owner's WhatsApp number as a linked device (like WhatsApp Web), via
 * Baileys. The session lives in the whatsapp_auth table, so after a redeploy
 * the API reconnects on its own; a QR scan is needed only the first time or
 * after "Unlink".
 */

export type ConnectionState = 'off' | 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out'

const status: { state: ConnectionState; qrDataUrl: string | null; me: string | null; lastError: string | null; since: string } = {
  state: 'off',
  qrDataUrl: null,
  me: null,
  lastError: null,
  since: new Date().toISOString(),
}

let sock: WASocket | null = null
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectAttempts = 0
let qrShown = 0

export const whatsappStatus = () => ({ ...status })

function setState(state: ConnectionState, extra: Partial<typeof status> = {}) {
  Object.assign(status, { state, since: new Date().toISOString() }, extra)
}

// ---------------------------------------------------------------------------
// Session storage in Postgres (same shape as Baileys' useMultiFileAuthState)
// ---------------------------------------------------------------------------

async function readData<T>(id: string): Promise<T | null> {
  const row = await queryOne<{ value: unknown }>('SELECT value FROM whatsapp_auth WHERE id = $1', [id])
  return row ? (JSON.parse(JSON.stringify(row.value), BufferJSON.reviver) as T) : null
}

async function writeData(id: string, data: unknown): Promise<void> {
  await query(
    `INSERT INTO whatsapp_auth (id, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [id, JSON.stringify(data, BufferJSON.replacer)]
  )
}

async function removeData(id: string): Promise<void> {
  await query('DELETE FROM whatsapp_auth WHERE id = $1', [id])
}

async function useDbAuthState(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const creds = (await readData<AuthenticationCreds>('creds')) ?? initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData<unknown>(`${type}-${id}`)
              if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object)
              if (value) data[id] = value as SignalDataTypeMap[typeof type]
            })
          )
          return data
        },
        set: async (data) => {
          const tasks: Promise<void>[] = []
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const id of Object.keys(data[category] ?? {})) {
              const value = data[category]?.[id]
              tasks.push(value ? writeData(`${category}-${id}`, value) : removeData(`${category}-${id}`))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  }
}

export async function hasSession(): Promise<boolean> {
  const creds = await readData<AuthenticationCreds>('creds')
  return Boolean(creds?.registered || creds?.me)
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

// Baileys is chatty; keep only warnings and errors.
const logger = {
  level: 'warn',
  child() {
    return logger
  },
  trace() {},
  debug() {},
  info() {},
  warn(obj: unknown, msg?: string) {
    console.warn('[whatsapp]', msg ?? '', typeof obj === 'string' ? obj : '')
  },
  error(obj: unknown, msg?: string) {
    console.error('[whatsapp]', msg ?? '', obj instanceof Error ? obj.message : '')
  },
}

export async function connect(): Promise<void> {
  if (sock && (status.state === 'connected' || status.state === 'connecting' || status.state === 'qr')) return
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  setState('connecting', { qrDataUrl: null, lastError: null })
  qrShown = 0

  const { state, saveCreds } = await useDbAuthState()
  const version = await fetchLatestBaileysVersion()
    .then((v) => v.version)
    .catch(() => undefined)

  const socket = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: logger as never,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  })
  sock = socket

  socket.ev.on('creds.update', () => {
    saveCreds().catch((err) => console.error('[whatsapp] could not save session', err))
  })

  socket.ev.on('connection.update', async (u) => {
    if (sock !== socket) return
    if (u.qr) {
      qrShown += 1
      // Stop offering codes after ~3 minutes if nobody scans; the admin can try again.
      if (qrShown > 8) {
        setState('disconnected', { qrDataUrl: null, lastError: 'QR code expired. Click Connect to get a new one.' })
        socket.end(undefined)
        sock = null
        return
      }
      setState('qr', { qrDataUrl: await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }) })
    }
    if (u.connection === 'open') {
      reconnectAttempts = 0
      setState('connected', { qrDataUrl: null, me: socket.user?.id?.split(':')[0]?.split('@')[0] ?? null, lastError: null })
      console.log(`[whatsapp] connected as +${status.me}`)
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
      sock = null
      if (code === DisconnectReason.loggedOut) {
        await query('DELETE FROM whatsapp_auth').catch(() => {})
        setState('logged_out', { qrDataUrl: null, me: null, lastError: 'This device was unlinked from the phone. Connect again to scan a new QR code.' })
        console.warn('[whatsapp] logged out')
        return
      }
      if (status.state === 'disconnected') return // QR expired above
      // Network blips, restarts required by WhatsApp, etc.: reconnect with backoff.
      reconnectAttempts += 1
      const delay = Math.min(5 * 60_000, 3000 * 2 ** Math.min(reconnectAttempts, 7))
      setState('connecting', { lastError: u.lastDisconnect?.error?.message ?? null })
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect().catch((err) => setState('disconnected', { lastError: (err as Error).message }))
      }, delay)
      reconnectTimer.unref()
    }
  })
}

/** Unlink this device from the phone and forget the session. */
export async function logout(): Promise<void> {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  const s = sock
  sock = null
  try {
    await s?.logout()
  } catch {
    // Already gone; the session is cleared below either way.
  }
  await query('DELETE FROM whatsapp_auth')
  setState('logged_out', { qrDataUrl: null, me: null, lastError: null })
}

const jid = (e164: string) => `${e164.replace(/\D/g, '')}@s.whatsapp.net`

export const baileysTransport: WhatsAppTransport = {
  isConnected: () => status.state === 'connected' && sock !== null,
  async exists(e164) {
    if (!sock) throw new Error('WhatsApp is not connected')
    const results = (await sock.onWhatsApp(jid(e164))) ?? []
    return Boolean(results[0]?.exists)
  },
  async typing(e164, ms) {
    if (!sock) throw new Error('WhatsApp is not connected')
    await sock.sendPresenceUpdate('composing', jid(e164))
    await new Promise((r) => setTimeout(r, ms))
    await sock.sendPresenceUpdate('paused', jid(e164))
  },
  async send(e164, text) {
    if (!sock) throw new Error('WhatsApp is not connected')
    await sock.sendMessage(jid(e164), { text })
  },
}

/**
 * Called once at API startup (when WHATSAPP_ENABLED=true): reconnect an
 * existing session and start the sending loop. Without a session it waits
 * for an admin to click Connect.
 */
export async function startWhatsApp(): Promise<void> {
  setState('disconnected')
  if (await hasSession()) {
    connect().catch((err) => setState('disconnected', { lastError: (err as Error).message }))
  }
  startSenderLoop(baileysTransport).catch((err) => console.error('[whatsapp] sender stopped', err))
  console.log('[whatsapp] sender started')
}
