import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-dispatch-webhook-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors })

  const webhookSecret = Deno.env.get('DISPATCH_WEBHOOK_SECRET') || ''
  if (!webhookSecret || req.headers.get('x-dispatch-webhook-secret') !== webhookSecret) {
    return new Response('Unauthorized', { status: 401, headers: cors })
  }

  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY') || ''
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY') || ''
  const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com'
  if (!publicKey || !privateKey) return new Response('VAPID keys are not configured', { status: 500, headers: cors })

  let payload: any
  try { payload = await req.json() } catch { return new Response('Invalid JSON', { status: 400, headers: cors }) }
  const notificationId = payload?.record?.id || payload?.id
  if (typeof notificationId !== 'string') return new Response('Notification id is required', { status: 400, headers: cors })

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(url, serviceKey)
  const { data: notification, error: notificationError } = await admin
    .from('user_notifications')
    .select('id,user_id,title,body,request_id')
    .eq('id', notificationId)
    .maybeSingle()
  if (notificationError) return new Response(notificationError.message, { status: 500, headers: cors })
  if (!notification) return new Response('Notification not found', { status: 404, headers: cors })

  const { data: subscriptions, error: subscriptionsError } = await admin
    .from('push_subscriptions')
    .select('id,endpoint,p256dh,auth')
    .eq('user_id', notification.user_id)
  if (subscriptionsError) return new Response(subscriptionsError.message, { status: 500, headers: cors })
  if (!subscriptions?.length) return new Response(JSON.stringify({ sent: 0 }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  webpush.setVapidDetails(subject, publicKey, privateKey)
  const message = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: '/',
    tag: 'dispatch-' + notification.id
  })

  let sent = 0
  const expired: string[] = []
  const results = await Promise.allSettled(subscriptions.map(async (item) => {
    try {
      await webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } }, message)
      sent++
    } catch (error) {
      const statusCode = Number((error as { statusCode?: number })?.statusCode || 0)
      if (statusCode === 404 || statusCode === 410) expired.push(item.id)
      else console.error('Push delivery failed:', statusCode, error)
    }
  }))
  if (expired.length) await admin.from('push_subscriptions').delete().in('id', expired)
  const failed = results.filter((item) => item.status === 'rejected').length
  return new Response(JSON.stringify({ sent, expired: expired.length, failed }), {
    headers: { ...cors, 'Content-Type': 'application/json' }
  })
})
