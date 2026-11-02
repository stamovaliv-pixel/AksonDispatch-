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

  const admin = createClient(url, service)
  const actorId = userData.user.id
  const { data: actor } = await admin.from('profiles').select('role,is_active').eq('id', actorId).single()
  if (!actor?.is_active || actor.role !== 'admin') return json({ error: 'Forbidden' }, 403)

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON body.' }, 400) }

  const userId = String(body.user_id || '')
  const username = String(body.username || '').trim()
  const role = String(body.role || '')
  const businessUnitId = typeof body.business_unit_id === 'string' && body.business_unit_id ? body.business_unit_id : null
  const defaultFromId = typeof body.default_from_id === 'string' && body.default_from_id ? body.default_from_id : null
  const password = typeof body.password === 'string' ? body.password : ''
  if (body.is_active !== undefined && typeof body.is_active !== 'boolean') {
    return json({ error: 'Поле is_active должно иметь логическое значение.' }, 400)
  }
  const isActive = typeof body.is_active === 'boolean' ? body.is_active : undefined

  if (!userId || !/^[A-Za-z0-9_-]{3,40}$/.test(username) || !['customer', 'dispatcher', 'utz', 'admin'].includes(role)) {
    return json({ error: 'Проверьте логин и роль пользователя.' }, 400)
  }
  if (password && (password.length < 12 || password.length > 128)) {
    return json({ error: 'Новый пароль должен содержать от 12 до 128 символов.' }, 400)
  }
  if (userId === actorId && (role !== 'admin' || isActive === false)) {
    return json({ error: 'Нельзя снять роль администратора или отключить собственную учётную запись.' }, 400)
  }

  const { data: oldProfile, error: profileReadError } = await admin.from('profiles')
    .select('id,username,role,business_unit_id,default_from_id,is_active')
    .eq('id', userId).single()
  if (profileReadError || !oldProfile) return json({ error: 'Пользователь не найден.' }, 404)
  const { data: existingProfiles, error: usernameLookupError } = await admin.from('profiles').select('id,username').neq('id', userId)
  if (usernameLookupError) return json({ error: 'Не удалось проверить уникальность логина.' }, 500)
  if ((existingProfiles || []).some((profile) => profile.username.toLowerCase() === username.toLowerCase())) {
    return json({ error: 'Пользователь с таким логином уже существует. Логин не должен отличаться только регистром.' }, 409)
  }

  const unitIds = [businessUnitId, defaultFromId].filter((value): value is string => Boolean(value))
  let unitRows: { id: string; kind: string; is_active: boolean }[] = []
  if (unitIds.length) {
    const { data, error } = await admin.from('business_units').select('id,kind,is_active').in('id', [...new Set(unitIds)])
    if (error) return json({ error: 'Не удалось проверить выбранные БЕ.' }, 500)
    unitRows = data || []
  }
  if (businessUnitId) {
    const assigned = unitRows.find((unit) => unit.id === businessUnitId)
    if (!assigned || assigned.kind !== 'BE' || !assigned.is_active) {
      return json({ error: 'Бизнес-единица должна быть действующей БЕ.' }, 400)
    }
  }
  if (defaultFromId) {
    const origin = unitRows.find((unit) => unit.id === defaultFromId)
    if (!origin || origin.kind !== 'BE' || !origin.is_active) {
      return json({ error: 'БЕ по умолчанию должна быть действующей.' }, 400)
    }
  }

  const email = `${username.toLowerCase()}@login.akson-transport.invalid`
  const { data: authUser, error: authReadError } = await admin.auth.admin.getUserById(userId)
  if (authReadError || !authUser.user) return json({ error: 'Не удалось найти учётную запись авторизации.' }, 404)
  const oldEmail = authUser.user.email

  const authUpdate: { email?: string; email_confirm?: boolean; password?: string } = {}
  if (oldProfile.username.toLowerCase() !== username.toLowerCase()) {
    authUpdate.email = email
    authUpdate.email_confirm = true
  }
  if (password) authUpdate.password = password

  if (Object.keys(authUpdate).length) {
    const { error } = await admin.auth.admin.updateUserById(userId, authUpdate)
    if (error) return json({ error: `Не удалось обновить данные входа: ${error.message}` }, 400)
  }

  const updatePayload: Record<string, unknown> = {
    username, role, business_unit_id: businessUnitId, default_from_id: defaultFromId
  }
  if (isActive !== undefined) updatePayload.is_active = isActive
  const { error: updateError } = await admin.from('profiles').update(updatePayload).eq('id', userId)
  if (updateError) {
    if (authUpdate.email && oldEmail) {
      await admin.auth.admin.updateUserById(userId, { email: oldEmail, email_confirm: true })
    }
    return json({ error: updateError.message }, 400)
  }

  const { error: auditError } = await admin.from('audit_log').insert({
    actor_id: actorId,
    action: 'profile_update',
    entity_type: 'profile',
    entity_id: userId,
    details: {
      username,
      old: {
        username: oldProfile.username, role: oldProfile.role,
        business_unit_id: oldProfile.business_unit_id,
        default_from_id: oldProfile.default_from_id,
        is_active: oldProfile.is_active
      },
      new: {
        username, role, business_unit_id: businessUnitId,
        default_from_id: defaultFromId,
        is_active: isActive === undefined ? oldProfile.is_active : isActive,
        password_changed: Boolean(password)
      }
    }
  })
  if (auditError) return json({ error: `Профиль обновлён, но не удалось записать событие аудита: ${auditError.message}` }, 500)

  return json({ id: userId, username, role, is_active: isActive === undefined ? oldProfile.is_active : isActive })
})
