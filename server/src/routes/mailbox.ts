import { Router } from 'express'
import {
  deleteMail,
  getMailbox,
  listMail,
  readMail,
  resetMailbox,
  setMailboxName,
  MIN_POLL_MS,
} from '../mailbox.js'

export const mailboxRouter = Router()

/**
 * The MailBox page — a disposable inbox for sign-up / OTP / reset-link testing.
 *
 * The `sid_token` behind the inbox NEVER leaves the server: it is the key to the
 * mailbox, and the browser has no use for it (every call goes through here). Failures
 * come back as `{ error }` like everywhere else, so `lib/api.ts` unwraps them into a
 * toast the engineer can act on.
 */

const fail = (res: Parameters<Parameters<typeof mailboxRouter.get>[1]>[1], err: unknown) =>
  res.status(502).json({ error: err instanceof Error ? err.message : 'the mail service failed' })

/** The current address (creating an inbox on first open) + how fast it may be polled. */
mailboxRouter.get('/', async (_req, res) => {
  try {
    const session = await getMailbox()
    res.json({ address: session.address, createdAt: session.createdAt, minPollMs: MIN_POLL_MS })
  } catch (err) {
    fail(res, err)
  }
})

mailboxRouter.get('/messages', async (_req, res) => {
  try {
    const { session, messages } = await listMail()
    res.json({ address: session.address, messages })
  } catch (err) {
    fail(res, err)
  }
})

mailboxRouter.get('/messages/:id', async (req, res) => {
  try {
    res.json(await readMail(req.params.id))
  } catch (err) {
    fail(res, err)
  }
})

mailboxRouter.delete('/messages/:id', async (req, res) => {
  try {
    await deleteMail(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})

/** Rename the inbox — the "think up any address" move this kind of service exists for. */
mailboxRouter.post('/address', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : ''
  try {
    const session = await setMailboxName(name)
    res.json({ address: session.address })
  } catch (err) {
    // A rejected name is the user's input, not a service outage: 400, so the page can
    // show it under the field instead of as "the mail service failed".
    const message = err instanceof Error ? err.message : 'could not set that address'
    res.status(/at least one letter|too long|refused|taken/i.test(message) ? 400 : 502).json({
      error: message,
    })
  }
})

/** Abandon this inbox and take a fresh random one. */
mailboxRouter.post('/reset', async (_req, res) => {
  try {
    const session = await resetMailbox()
    res.json({ address: session.address })
  } catch (err) {
    fail(res, err)
  }
})
