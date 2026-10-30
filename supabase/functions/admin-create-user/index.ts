import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors })
  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authHeader = req.headers.get('Authorization') || ''
  const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userError } = await caller.auth.getUser()
  if (userError || !userData.user) return new Response('Unauthorized', { status: 401, headers: cors })
  const admin = createClient(url, service)
  const { data: actor } = await admin.from('profiles').select('role,is_active').eq('id', userData.user.id).single()
  if (!actor?.is_active || actor.role !== 'admin') return new Response('Forbidden', { status: 403, headers: cors })

  const body = await req.json()
  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const role = String(body.role || 'customer')
  const business_unit_id = body.business_unit_id || null
  const default_from_id = body.default_from_id || null
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(username) || password.length < 12 || !['customer','dispatcher','utz','admin'].includes(role)) {
    return new Response('Invalid input: username format, password length (12+), or role.', { status: 400, headers: cors })
  }
  if (password.length > 128) {
    return new Response('Invalid input: password must not exceed 128 characters.', { status: 400, headers: cors })
  }

  const unitIds = [business_unit_id, default_from_id].filter((value): value is string => typeof value === 'string' && value.length > 0)
  let unitRows: { id: string; kind: string; is_active: boolean }[] = []
  if (unitIds.length) {
    const { data, error: unitsError } = await admin.from('business_units')
      .select('id,kind,is_active')
      .in('id', [...new Set(unitIds)])
    if (unitsError) return new Response('Could not validate business-unit assignment.', { status: 500, headers: cors })
    unitRows = data || []
  }
  if (role === 'customer') {
    const assigned = unitRows.find((unit) => unit.id === business_unit_id)
    if (!assigned || assigned.kind !== 'BE' || !assigned.is_active) {
      return new Response('Customer must be assigned to an active business unit (BE).', { status: 400, headers: cors })
    }
  }
  if (default_from_id) {
    const origin = unitRows.find((unit) => unit.id === default_from_id)
    if (!origin || origin.kind !== 'BE' || !origin.is_active) {
      return new Response('Default origin must be an active business unit (BE).', { status: 400, headers: cors })
    }
  }

  const email = `${username.toLowerCase()}@login.akson-transport.invalid`
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (createError) return new Response(createError.message, { status: 400, headers: cors })
  const { error: profileError } = await admin.from('profiles').insert({ id: created.user.id, username, role, business_unit_id, default_from_id, is_active: true })
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id)
    return new Response(profileError.message, { status: 400, headers: cors })
  }
  return new Response(JSON.stringify({ id: created.user.id, username, role }), { headers: { ...cors, 'Content-Type': 'application/json' } })
})
