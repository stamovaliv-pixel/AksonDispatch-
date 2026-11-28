import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json' }
})

type PortalRole = 'super_admin' | 'admin' | 'technician' | 'utz' | 'dispatcher' | 'be' | 'customer'
type LegacyRole = 'customer' | 'dispatcher' | 'utz' | 'admin'
type DispatcherPosition = 'Диспетчер' | 'Руководитель РЦ' | 'Старший смены РЦ'
const portalRoles: PortalRole[] = ['super_admin', 'admin', 'technician', 'utz', 'dispatcher', 'be', 'customer']
const positions: DispatcherPosition[] = ['Диспетчер', 'Руководитель РЦ', 'Старший смены РЦ']
const legacyRoleFor = (role: PortalRole): LegacyRole => {
  if (role === 'super_admin' || role === 'admin') return 'admin'
  if (role === 'technician' || role === 'be') return 'customer'
  if (role === 'utz') return 'utz'
  if (role === 'dispatcher') return 'dispatcher'
  return 'customer'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anon || !service) return json({ error: 'Server configuration is incomplete.' }, 500)

  const authHeader = req.headers.get('Authorization') || ''
  const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: userData, error: userError } = await caller.auth.getUser()
  if (userError || !userData.user) return json({ error: 'Unauthorized' }, 401)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body.' }, 400) }

  const admin = createClient(url, service)
  const actorId = userData.user.id
  const { data: actor, error: actorError } = await admin.from('profiles')
    .select('role,portal_role,is_active').eq('id', actorId).single()
  if (actorError || !actor?.is_active || !['admin', 'super_admin'].includes(String(actor.portal_role || actor.role))) {
    return json({ error: 'Forbidden' }, 403)
  }
  const actorPortalRole = String(actor.portal_role || actor.role)
  const canAssignSuperAdmin = actorPortalRole === 'super_admin'

  const username = String(body.username || '').trim()
  const password = String(body.password || '')
  const requestedRole = String(body.portal_role || body.role || 'customer') as PortalRole
  const businessUnitId = typeof body.business_unit_id === 'string' && body.business_unit_id ? body.business_unit_id : null
  const defaultFromId = typeof body.default_from_id === 'string' && body.default_from_id ? body.default_from_id : null
  const positionValue = body.position_title == null ? '' : String(body.position_title)

  if (!/^[A-Za-z0-9_-]{3,40}$/.test(username)) return json({ error: 'Логин: 3–40 символов, латиница, цифры, дефис и подчёркивание.' }, 400)
  if (password.length < 12 || password.length > 128) return json({ error: 'Пароль должен содержать от 12 до 128 символов.' }, 400)
  if (!portalRoles.includes(requestedRole)) return json({ error: 'Неизвестная роль портала.' }, 400)
  if (requestedRole === 'super_admin' && !canAssignSuperAdmin) return json({ error: 'Назначить суперадминистратора может только суперадминистратор.' }, 403)

  const positionTitle: DispatcherPosition | null = requestedRole === 'dispatcher'
    ? (positions.includes(positionValue as DispatcherPosition) ? positionValue as DispatcherPosition : 'Диспетчер')
    : null
  if (requestedRole !== 'dispatcher' && positionValue) return json({ error: 'Должность может быть указана только для роли «Диспетчер».' }, 400)

  const { data: existingProfiles, error: usernameLookupError } = await admin.from('profiles').select('id,username')
  if (usernameLookupError) return json({ error: 'Не удалось проверить уникальность логина.' }, 500)
  if ((existingProfiles || []).some((profile) => profile.username.toLowerCase() === username.toLowerCase())) {
    return json({ error: 'Пользователь с таким логином уже существует. Логин не должен отличаться только регистром.' }, 409)
  }

  const unitIds = [businessUnitId, defaultFromId].filter((value): value is string => Boolean(value))
  let unitRows: { id: string; kind: string; is_active: boolean }[] = []
  if (unitIds.length) {
    const { data, error } = await admin.from('business_units').select('id,kind,is_active').in('id', [...new Set(unitIds)])
    if (error) return json({ error: 'Не удалось проверить выбранные бизнес-единицы.' }, 500)
    unitRows = data || []
  }
  if (requestedRole === 'be' && !businessUnitId) return json({ error: 'Для роли БЕ необходимо назначить бизнес-единицу.' }, 400)
  if (businessUnitId) {
    const assigned = unitRows.find((unit) => unit.id === businessUnitId)
    if (!assigned || assigned.kind !== 'BE' || !assigned.is_active) return json({ error: 'Назначение должно ссылаться на действующую БЕ.' }, 400)
  }
  if (defaultFromId) {
    const origin = unitRows.find((unit) => unit.id === defaultFromId)
    if (!origin || origin.kind !== 'BE' || !origin.is_active) return json({ error: 'БЕ по умолчанию должна быть действующей.' }, 400)
  }

  const email = `${username.toLowerCase()}@login.akson-transport.invalid`
  const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (createError || !created.user) return json({ error: createError?.message || 'Не удалось создать пользователя.' }, 400)

  const legacyRole = legacyRoleFor(requestedRole)
  const { error: profileError } = await admin.from('profiles').insert({
    id: created.user.id,
    username,
    role: legacyRole,
    portal_role: requestedRole,
    position_title: positionTitle,
    business_unit_id: businessUnitId,
    default_from_id: defaultFromId,
    is_active: true
  })
  if (profileError) {
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: profileError.message }, 400)
  }

  const { error: auditError } = await admin.from('audit_log').insert({
    actor_id: actorId,
    action: 'profile_create',
    entity_type: 'profile',
    entity_id: created.user.id,
    details: { username, legacy_role: legacyRole, portal_role: requestedRole, position_title: positionTitle, business_unit_id: businessUnitId, default_from_id: defaultFromId }
  })
  if (auditError) {
    await admin.from('profiles').delete().eq('id', created.user.id)
    await admin.auth.admin.deleteUser(created.user.id)
    return json({ error: `Не удалось записать аудит создания пользователя: ${auditError.message}` }, 500)
  }

  return json({ id: created.user.id, username, role: legacyRole, portal_role: requestedRole, position_title: positionTitle })
})
