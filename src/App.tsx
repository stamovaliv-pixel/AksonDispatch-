import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight,
  Building2, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, FileSpreadsheet, Filter, LayoutDashboard, LogOut, Menu, Moon,
  Package, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sun, Truck, Users,
  Warehouse, X, Pencil, Ban, Eye, Layers3
} from 'lucide-react'
import { supabase, supabaseConfigured } from './lib/supabase'
import type { BusinessUnit, CargoLine, Profile, RequestStatus, Role, TransportRequest } from './types'

type View = 'overview' | 'calendar' | 'requests' | 'users' | 'directory'
type RequestDraft = {
  transport_date: string; slot_number: number; from_unit_id: string | null; from_other_address: string | null;
  to_unit_id: string | null; to_other_address: string | null; capacity_tons: number; loading_type: 'rear' | 'side';
  cargo_types: string[]; stock_pallets: number; kdk_pallets: number; packaging_qty: number
}
type UnitDraft = { code: string; name: string; kind: 'BE' | 'RC'; address: string }
type SlotOccupancy = { transport_date: string; slot_number: number }

const roleNames: Record<Role, string> = { customer: 'Заказчик', dispatcher: 'Диспетчер', utz: 'УТЗ', admin: 'Администратор' }
const roleDescriptions: Record<Role, string> = {
  customer: 'Создание и просмотр заявок своей БЕ', dispatcher: 'Работа с заявками и слотами',
  utz: 'Контроль и координация перевозок', admin: 'Полное администрирование портала'
}
const statusNames: Record<RequestStatus, string> = { created: 'Создана', search: 'Поиск транспорта', confirmed: 'Подтверждена', completed: 'Выполнена', cancelled: 'Отменена' }
const statusClasses: Record<RequestStatus, string> = { created: 'status-created', search: 'status-search', confirmed: 'status-confirmed', completed: 'status-completed', cancelled: 'status-cancelled' }
const cargoNames: Record<string, string> = { goods: 'Товар', equipment: 'Оборудование', packaging: 'Тара' }
const today = new Date()
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const monthTitle = (d: Date) => d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
const dateLabel = (value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) => new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU', options)
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Не удалось выполнить операцию. Попробуйте ещё раз.'

function App() {
  const [session, setSession] = useState<any>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [units, setUnits] = useState<BusinessUnit[]>([])
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [occupancy, setOccupancy] = useState<SlotOccupancy[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [view, setView] = useState<View>('overview')
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [selectedDay, setSelectedDay] = useState(iso(today))
  const [requestModal, setRequestModal] = useState<{ open: boolean; request?: TransportRequest; slot?: number }>({ open: false })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | RequestStatus>('all')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('akson-transport-theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showUserForm, setShowUserForm] = useState(false)
  const [userDraft, setUserDraft] = useState({ username: '', password: '', role: 'customer' as Role, business_unit_id: '', default_from_id: '' })
  const [unitDraft, setUnitDraft] = useState<UnitDraft>({ code: '', name: '', kind: 'BE', address: '' })
  const [unitFormOpen, setUnitFormOpen] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('akson-transport-theme', theme) } catch { /* private browsing */ }
  }, [theme])

  useEffect(() => {
    if (!supabase) return
    let alive = true
    supabase.auth.getSession().then(({ data }) => { if (alive) setSession(data.session) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => { alive = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!session || !supabase) { setProfile(null); setPeople([]); return }
    let alive = true
    supabase.from('profiles').select('*').eq('id', session.user.id).single().then(async ({ data, error: profileError }) => {
      if (!alive) return
      if (profileError || !data) { setError(`Не удалось загрузить профиль: ${profileError?.message || 'профиль не найден'}`); return }
      if (!data.is_active) { await supabase?.auth.signOut(); setError('Учётная запись заблокирована администратором.'); return }
      setProfile(data as Profile)
      setError('')
    })
    return () => { alive = false }
  }, [session])

  useEffect(() => { if (profile) void loadData() }, [profile, month])
  useEffect(() => { if (profile?.role === 'admin' && view === 'users') void loadPeople() }, [profile, view])

  async function loadData() {
    if (!supabase || !profile) return
    setLoading(true); setError('')
    const fromDate = iso(new Date(month.getFullYear(), month.getMonth(), 1))
    const toDate = iso(new Date(month.getFullYear(), month.getMonth() + 1, 0))
    let unitsQuery = supabase.from('business_units').select('*').order('code')
    if (profile.role !== 'admin') unitsQuery = unitsQuery.eq('is_active', true)
    const [unitResult, requestResult, occupancyResult] = await Promise.all([
      unitsQuery,
      supabase.from('transport_requests')
        .select('*, profiles!transport_requests_requester_id_fkey(username), business_units!transport_requests_business_unit_id_fkey(code,name), request_cargo(cargo_type,stock_pallets,kdk_pallets,packaging_qty)')
        .gte('transport_date', fromDate).lte('transport_date', toDate).order('transport_date').order('slot_number'),
      supabase.rpc('get_slot_occupancy', { p_from_date: fromDate, p_to_date: toDate })
    ])
    if (unitResult.error) setError(`Справочник: ${unitResult.error.message}`)
    else setUnits((unitResult.data || []) as BusinessUnit[])
    if (requestResult.error) setError(`Заявки: ${requestResult.error.message}`)
    else setRequests((requestResult.data || []) as TransportRequest[])
    if (occupancyResult.error) setError(`Занятость слотов: ${occupancyResult.error.message}. Примените миграцию 0002_admin_workspace.sql.`)
    else setOccupancy((occupancyResult.data || []) as SlotOccupancy[])
    setLoading(false)
  }

  async function loadPeople() {
    if (!supabase || profile?.role !== 'admin') return
    const { data, error: peopleError } = await supabase.from('profiles')
      .select('id,username,role,business_unit_id,default_from_id,is_active,created_at')
      .order('username')
    if (peopleError) setError(`Пользователи: ${peopleError.message}`)
    else setPeople((data || []) as Profile[])
  }

  async function signIn(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setLoginBusy(true); setError('')
    const synthetic = `${login.trim().toLowerCase()}@login.akson-transport.invalid`
    const { error: authError } = await supabase.auth.signInWithPassword({ email: synthetic, password })
    if (authError) setError('Не удалось войти. Проверьте логин и пароль.')
    setLoginBusy(false)
  }

  async function signOut() {
    await supabase?.auth.signOut()
    setSession(null); setProfile(null); setView('overview')
  }

  async function saveRequest(payload: RequestDraft, existing?: TransportRequest) {
    if (!supabase || !profile) return
    setSaving(true); setError('')
    try {
      const businessUnitId = existing?.business_unit_id || profile.business_unit_id
      if (!businessUnitId) throw new Error('Для учётной записи не назначена бизнес-единица. Обратитесь к администратору.')
      const base = {
        requester_id: existing?.requester_id || profile.id, business_unit_id: businessUnitId,
        transport_date: payload.transport_date, slot_number: payload.slot_number,
        from_unit_id: payload.from_unit_id, from_other_address: payload.from_other_address,
        to_unit_id: payload.to_unit_id, to_other_address: payload.to_other_address,
        capacity_tons: payload.capacity_tons, loading_type: payload.loading_type
      }
      let id = existing?.id
      if (existing) {
        const { error: updateError } = await supabase.from('transport_requests').update(base).eq('id', existing.id)
        if (updateError) throw updateError
      } else {
        const { data, error: insertError } = await supabase.from('transport_requests').insert(base).select('id').single()
        if (insertError) throw insertError
        id = data.id
      }
      if (!id) throw new Error('Не удалось определить номер заявки.')
      const { error: deleteError } = await supabase.from('request_cargo').delete().eq('request_id', id)
      if (deleteError) throw deleteError
      const cargoRows: CargoLine[] = payload.cargo_types.map((cargoType) => ({
        cargo_type: cargoType as CargoLine['cargo_type'], stock_pallets: payload.stock_pallets,
        kdk_pallets: payload.kdk_pallets, packaging_qty: payload.packaging_qty
      }))
      if (cargoRows.length) {
        const { error: cargoError } = await supabase.from('request_cargo').insert(cargoRows.map((row) => ({ ...row, request_id: id })))
        if (cargoError) throw cargoError
      }
      setRequestModal({ open: false }); setSelectedDay(payload.transport_date); setView('calendar')
      setNotice(existing ? 'Заявка обновлена.' : 'Заявка создана.')
      await loadData()
    } catch (e) { setError(errorText(e)) }
    finally { setSaving(false) }
  }

  async function changeStatus(request: TransportRequest, status: RequestStatus) {
    if (!supabase) return
    setError('')
    const { error: updateError } = await supabase.from('transport_requests').update({ status }).eq('id', request.id)
    if (updateError) setError(updateError.message)
    else { setNotice(`Статус заявки №${request.request_no} изменён.`); await loadData() }
  }

  async function cancelRequest(request: TransportRequest) {
    if (!supabase || !window.confirm(`Отменить заявку №${request.request_no}?`)) return
    await changeStatus(request, 'cancelled')
  }

  async function createUser(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    if (userDraft.role === 'customer' && !userDraft.business_unit_id) { setError('Для заказчика необходимо выбрать БЕ.'); return }
    setSaving(true); setError('')
    const { data, error: invokeError } = await supabase.functions.invoke('admin-create-user', {
      body: {
        username: userDraft.username.trim(), password: userDraft.password, role: userDraft.role,
        business_unit_id: userDraft.business_unit_id || null, default_from_id: userDraft.default_from_id || null
      }
    })
    setSaving(false)
    if (invokeError) { setError(`Не удалось создать пользователя. Проверьте, что Edge Function admin-create-user развёрнута. ${invokeError.message}`); return }
    if (data?.error) { setError(String(data.error)); return }
    setNotice(`Пользователь ${userDraft.username.trim()} создан.`)
    setUserDraft({ username: '', password: '', role: 'customer', business_unit_id: '', default_from_id: '' })
    setShowUserForm(false); await loadPeople()
  }

  async function toggleUser(profileRow: Profile) {
    if (!supabase || profileRow.id === profile?.id) return
    const { error: updateError } = await supabase.from('profiles').update({ is_active: !profileRow.is_active }).eq('id', profileRow.id)
    if (updateError) setError(`Не удалось изменить доступ. ${updateError.message}`)
    else { setNotice(profileRow.is_active ? 'Доступ пользователя приостановлен.' : 'Доступ пользователя восстановлен.'); await loadPeople() }
  }

  async function saveUnit(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setSaving(true); setError('')
    const { error: unitError } = await supabase.from('business_units').insert({
      code: unitDraft.code.trim(), name: unitDraft.name.trim(), kind: unitDraft.kind,
      address: unitDraft.address.trim() || null, is_active: true
    })
    setSaving(false)
    if (unitError) setError(unitError.message)
    else { setNotice('Элемент справочника добавлен.'); setUnitDraft({ code: '', name: '', kind: 'BE', address: '' }); setUnitFormOpen(false); await loadData() }
  }

  async function toggleUnit(unit: BusinessUnit) {
    if (!supabase) return
    const { error: unitError } = await supabase.from('business_units').update({ is_active: !unit.is_active }).eq('id', unit.id)
    if (unitError) setError(unitError.message)
    else { setNotice(unit.is_active ? 'Элемент справочника деактивирован.' : 'Элемент справочника активирован.'); await loadData() }
  }

  const calendarDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7
    const start = new Date(first); start.setDate(first.getDate() - offset)
    return Array.from({ length: 42 }, (_, i) => { const day = new Date(start); day.setDate(start.getDate() + i); return day })
  }, [month])

  const visibleRequests = useMemo(() => {
    const scoped = requests.filter((request) => profile?.role !== 'customer' || request.requester_id === profile.id)
    return scoped.filter((request) => {
      const matchesStatus = statusFilter === 'all' || request.status === statusFilter
      const query = search.trim().toLowerCase()
      const fromName = resolveUnit(units, request.from_unit_id, request.from_other_address).toLowerCase()
      const toName = resolveUnit(units, request.to_unit_id, request.to_other_address).toLowerCase()
      const requester = request.profiles?.username?.toLowerCase() || ''
      const matchesQuery = !query || String(request.request_no).includes(query) || fromName.includes(query) || toName.includes(query) || requester.includes(query)
      return matchesStatus && matchesQuery
    })
  }, [requests, profile, statusFilter, search, units])

  const activeRequests = requests.filter((r) => r.status !== 'cancelled')
  const countStatus = (status: RequestStatus) => requests.filter((r) => r.status === status).length
  const ownRequests = requests.filter((r) => profile?.role !== 'customer' || r.requester_id === profile?.id)
  const selectedRequests = ownRequests.filter((r) => r.transport_date === selectedDay)
  const isAdmin = profile?.role === 'admin'
  const pageTitles: Record<View, string> = { overview: 'Обзор', calendar: 'Календарь транспорта', requests: 'Заявки на транспорт', users: 'Пользователи', directory: 'Справочник БЕ и РЦ' }

  if (!supabaseConfigured) return <SetupScreen />
  if (!session || !profile) return <LoginScreen login={login} password={password} setLogin={setLogin} setPassword={setPassword} signIn={signIn} busy={loginBusy} error={error} />

  const navItems: { key: View; label: string; icon: typeof LayoutDashboard; admin?: boolean }[] = [
    { key: 'overview', label: 'Обзор', icon: LayoutDashboard },
    { key: 'calendar', label: 'Календарь', icon: CalendarDays },
    { key: 'requests', label: 'Заявки', icon: FileSpreadsheet },
    { key: 'users', label: 'Пользователи', icon: Users, admin: true },
    { key: 'directory', label: 'Справочник', icon: Building2, admin: true }
  ]

  return <div className="app-shell">
    <div className="top-gradient-bar" />
    <header className="app-topbar">
      <button className="mobile-menu icon-button" aria-label="Открыть меню" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={19} /></button>
      <div className="brand-area"><img src={theme === 'dark' ? '/assets/logistic-logo-dark.svg' : '/assets/logistic-logo.svg'} alt="Аксон Логистика" /><span className="brand-divider" /><div className="brand-product"><strong>Транспорт</strong><small>Портал заказов БЕ → РЦ</small></div></div>
      <div className="topbar-right"><div className="today-chip"><CalendarDays size={15} /><span>{today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</span></div><button className="icon-button" title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><div className="profile-chip"><div className="avatar">{profile.username.slice(0, 1).toUpperCase()}</div><div><strong>{profile.username}</strong><small>{roleNames[profile.role]}</small></div><ChevronDown size={14} /></div><button className="icon-button logout-button" title="Выйти" onClick={signOut}><LogOut size={17} /></button></div>
    </header>
    <div className="workspace">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="side-nav">
          {navItems.filter((item) => !item.admin || isAdmin).map((item) => {
            const Icon = item.icon
            return <button key={item.key} className={`nav-link ${view === item.key ? 'active' : ''}`} onClick={() => { setView(item.key); setSidebarOpen(false); setError(''); setNotice('') }}><Icon size={18} /><span>{item.label}</span>{item.key === 'requests' && activeRequests.length > 0 && <em>{activeRequests.length}</em>}</button>
          })}
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-help"><div className="help-icon"><ShieldCheck size={17} /></div><strong>Рабочая система</strong><p>Доступ к заявкам ограничен вашей ролью.</p></div><div className="sidebar-foot"><span className="online-dot" /> Supabase подключён</div></div>
      </aside>
      <main className="main-area">
        <div className="page-topline"><div><div className="breadcrumbs">АКСОН ЛОГИСТИКА <span>/</span> {pageTitles[view].toUpperCase()}</div><h1>{pageTitles[view]}</h1><p>{getSubtitle(view, profile)}</p></div><div className="page-actions">{(view === 'calendar' || view === 'requests') && <MonthControls month={month} setMonth={(nextMonth) => { setMonth(nextMonth); setSelectedDay(iso(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1))) }} />}{view === 'requests' && <button className="button button-secondary" onClick={() => { setSearch(''); setStatusFilter('all') }}><RefreshCw size={15} /> Сбросить фильтры</button>}{view === 'calendar' && profile.role === 'customer' && <button className="button button-primary" onClick={() => setRequestModal({ open: true })}><Plus size={16} /> Новая заявка</button>}</div></div>
        {error && <div className="message message-error"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Закрыть"><X size={15} /></button></div>}
        {notice && <div className="message message-success"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Закрыть"><X size={15} /></button></div>}
        {view === 'overview' && <OverviewView profile={profile} requests={ownRequests} occupancy={occupancy} units={units} onNavigate={setView} onRequest={() => setRequestModal({ open: true })} />}
        {view === 'calendar' && <CalendarView month={month} days={calendarDays} requests={ownRequests} allRequests={requests} occupancy={occupancy} selectedDay={selectedDay} setSelectedDay={setSelectedDay} profile={profile} units={units} onCreate={(slot) => setRequestModal({ open: true, slot })} onOpen={(request) => setRequestModal({ open: true, request })} />}
        {view === 'requests' && <RequestsView requests={visibleRequests} units={units} profile={profile} search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter} onStatus={changeStatus} onEdit={(request) => setRequestModal({ open: true, request })} onCancel={cancelRequest} />}
        {view === 'users' && isAdmin && <UsersView people={people} units={units} currentUserId={profile.id} formOpen={showUserForm} setFormOpen={setShowUserForm} draft={userDraft} setDraft={setUserDraft} onSubmit={createUser} onToggle={toggleUser} saving={saving} />}
        {view === 'directory' && isAdmin && <DirectoryView units={units} formOpen={unitFormOpen} setFormOpen={setUnitFormOpen} draft={unitDraft} setDraft={setUnitDraft} onSubmit={saveUnit} onToggle={toggleUnit} saving={saving} />}
        <footer className="app-footer"><span>АКСОН ЛОГИСТИКА</span><span>Портал заказа транспорта · {new Date().getFullYear()}</span></footer>
      </main>
    </div>
    {requestModal.open && <RequestModal units={units} profile={profile} occupancy={occupancy} request={requestModal.request} slot={requestModal.slot} onClose={() => setRequestModal({ open: false })} onSave={saveRequest} saving={saving} />}
    {loading && <div className="loading-pill"><span className="spinner" /> Обновляем данные…</div>}
  </div>
}

function SetupScreen() {
  return <div className="setup-screen"><div className="setup-card"><img src="/assets/logistic-logo.svg" alt="Аксон Логистика"/><div className="setup-mark"><Settings2 size={22}/></div><h1>Требуется настройка подключения</h1><p>В окружении проекта не найдены параметры Supabase. Добавьте в Vercel переменные <code>VITE_SUPABASE_URL</code> и <code>VITE_SUPABASE_ANON_KEY</code>, затем выполните новое развёртывание.</p></div></div>
}

function LoginScreen({ login, password, setLogin, setPassword, signIn, busy, error }: { login: string; password: string; setLogin: (v: string) => void; setPassword: (v: string) => void; signIn: (e: FormEvent) => void; busy: boolean; error: string }) {
  const [showPassword, setShowPassword] = useState(false)
  return <div className="login-screen"><div className="login-gradient"/><section className="login-panel"><div className="login-brand"><img src="/assets/logistic-logo.svg" alt="Аксон Логистика"/><span>ЛОГИСТИКА · ТРАНСПОРТ</span></div><div className="login-intro"><div className="login-icon"><Truck size={22}/></div><h1>Вход в портал</h1><p>Заказ транспорта между бизнес-единицами и распределительными центрами</p></div><form onSubmit={signIn} className="login-form"><label>Логин<input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Например, IVANOV01" autoComplete="username" required /></label><label>Пароль<div className="password-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Введите пароль" autoComplete="current-password" required/><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}><Eye size={17}/></button></div></label>{error && <div className="login-error"><AlertCircle size={16}/>{error}</div>}<button className="button button-primary login-submit" disabled={busy}>{busy ? 'Выполняется вход…' : 'Войти в систему'}<ArrowRight size={17}/></button></form><div className="login-bottom"><ShieldCheck size={15}/> Защищённый доступ для сотрудников Аксон</div></section><div className="login-side"><div className="side-illustration"><div className="illustration-orbit orbit-one"/><div className="illustration-orbit orbit-two"/><div className="illustration-truck"><Truck size={104} strokeWidth={1.05}/></div><div className="route-node node-a"/><div className="route-node node-b"/><div className="route-line"/></div><div className="login-side-copy"><span>АКСОН ЛОГИСТИКА</span><h2>Транспортная логистика<br/>в едином пространстве</h2><p>Заявки, слоты, маршруты и координация перевозок — без лишних операций.</p></div></div></div>
}

function getSubtitle(view: View, profile: Profile) {
  if (view === 'overview') return `Здравствуйте, ${profile.username}. Сводная информация по транспортным заявкам.`
  if (view === 'calendar') return 'Планирование трёх общих транспортных слотов на каждый день.'
  if (view === 'requests') return 'Поиск, контроль статусов и работа с заявками за выбранный месяц.'
  if (view === 'users') return 'Создание учётных записей и управление доступом сотрудников.'
  return 'Справочник бизнес-единиц и распределительных центров.'
}

function OverviewView({ profile, requests, occupancy, units, onNavigate, onRequest }: { profile: Profile; requests: TransportRequest[]; occupancy: SlotOccupancy[]; units: BusinessUnit[]; onNavigate: (view: View) => void; onRequest: () => void }) {
  const active = requests.filter((r) => !['cancelled', 'completed'].includes(r.status)).length
  const todayRequests = requests.filter((r) => r.transport_date === iso(today))
  const todayOccupancy = occupancy.filter((slot) => slot.transport_date === iso(today))
  const stats = [
    { label: 'Всего заявок', value: requests.length, icon: FileSpreadsheet, tone: 'blue', hint: 'За выбранный месяц' },
    { label: 'В работе', value: active, icon: Activity, tone: 'orange', hint: 'Ожидают обработки' },
    { label: 'Подтверждено', value: requests.filter((r) => r.status === 'confirmed').length, icon: CheckCircle2, tone: 'green', hint: 'Транспорт назначен' },
    { label: 'Выполнено', value: requests.filter((r) => r.status === 'completed').length, icon: Truck, tone: 'violet', hint: 'Завершённые перевозки' }
  ]
  const next = requests.filter((r) => r.transport_date >= iso(today) && !['cancelled', 'completed'].includes(r.status)).sort((a, b) => a.transport_date.localeCompare(b.transport_date) || a.slot_number - b.slot_number).slice(0, 5)
  return <div className="overview-page">
    <section className="welcome-banner"><div className="welcome-content"><div className="eyebrow">РАБОЧИЙ ЦЕНТР · АКСОН</div><h2>{profile.role === 'customer' ? 'Планируйте транспортные заявки' : 'Управляйте транспортным потоком'}</h2><p>{profile.role === 'customer' ? 'Создавайте заявки на перевозку и отслеживайте их статус в календаре.' : 'Все заявки, занятость слотов и ключевые показатели — в одном рабочем пространстве.'}</p><button className="welcome-link" onClick={() => onNavigate('calendar')}>Открыть календарь <ArrowRight size={16}/></button></div><div className="welcome-art"><div className="art-circle circle-large"/><div className="art-circle circle-small"/><Truck size={106} strokeWidth={1.15}/><div className="art-badge"><span/> Система активна</div></div></section>
    <div className="section-heading"><div><h2>Показатели за месяц</h2><p>Текущая статистика заявок</p></div><button className="subtle-link" onClick={() => onNavigate('requests')}>Все заявки <ArrowRight size={15}/></button></div>
    <div className="stats-grid">{stats.map((item) => { const Icon = item.icon; return <article className="stat-card" key={item.label}><div className={`stat-icon tone-${item.tone}`}><Icon size={19}/></div><div className="stat-label">{item.label}</div><div className="stat-value">{item.value}</div><div className="stat-hint">{item.hint}</div></article> })}</div>
    <div className="overview-grid"><section className="surface-card upcoming-card"><div className="card-heading"><div><h3>Ближайшие заявки</h3><p>Предстоящие перевозки</p></div><button className="icon-button" onClick={() => onNavigate('requests')}><ArrowUpRight size={17}/></button></div>{next.length ? <div className="upcoming-list">{next.map((r) => <div className="upcoming-row" key={r.id}><div className="upcoming-date"><strong>{new Date(`${r.transport_date}T00:00:00`).getDate()}</strong><span>{new Date(`${r.transport_date}T00:00:00`).toLocaleDateString('ru-RU', { month: 'short' })}</span></div><div className="upcoming-route"><strong>{resolveUnit(units, r.from_unit_id, r.from_other_address)} <ArrowRight size={13}/> {resolveUnit(units, r.to_unit_id, r.to_other_address)}</strong><small>Слот {r.slot_number} · {r.capacity_tons} т · №{r.request_no}</small></div><StatusBadge status={r.status}/></div>)}</div> : <EmptyState icon={CalendarDays} title="Предстоящих заявок нет" text="Когда появятся новые перевозки, они отобразятся здесь."/>}</section><section className="surface-card today-card"><div className="card-heading"><div><h3>Сегодня</h3><p>{today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div><div className="today-count">{todayOccupancy.length} <span>из 3 слотов</span></div></div><div className="today-slot-list">{[1, 2, 3].map((slot) => { const request = todayRequests.find((r) => r.slot_number === slot && r.status !== 'cancelled'); const occupied = todayOccupancy.some((s) => s.slot_number === slot); return <div className="today-slot" key={slot}><div className={`slot-indicator ${occupied ? 'filled' : ''}`}>{slot}</div><div><strong>Слот {slot}</strong><small>{request ? `Заявка №${request.request_no}` : occupied ? 'Занят другой заявкой' : 'Свободен'}</small></div><span className={occupied ? 'slot-state occupied' : 'slot-state free'}>{occupied ? 'Занят' : 'Свободен'}</span></div> })}</div><button className="wide-subtle-button" onClick={() => onNavigate('calendar')}>Перейти к календарю <ArrowRight size={15}/></button></section></div>
    <div className="overview-bottom"><div className="info-mini"><div className="mini-icon"><Building2 size={18}/></div><div><strong>{units.filter((u) => u.kind === 'BE').length} бизнес-единиц</strong><small>В активном справочнике</small></div></div><div className="info-mini"><div className="mini-icon purple"><Warehouse size={18}/></div><div><strong>{units.filter((u) => u.kind === 'RC').length} распределительных центров</strong><small>Доступно для маршрутов</small></div></div><div className="info-mini"><div className="mini-icon green"><ShieldCheck size={18}/></div><div><strong>{roleNames[profile.role]}</strong><small>Ваша роль в системе</small></div></div></div>
    {profile.role === 'customer' && <button className="floating-create" onClick={onRequest}><Plus size={19}/><span>Создать заявку</span></button>}
  </div>
}

function CalendarView({ month, days, requests, allRequests, occupancy, selectedDay, setSelectedDay, profile, units, onCreate, onOpen }: { month: Date; days: Date[]; requests: TransportRequest[]; allRequests: TransportRequest[]; occupancy: SlotOccupancy[]; selectedDay: string; setSelectedDay: (v: string) => void; profile: Profile; units: BusinessUnit[]; onCreate: (slot: number) => void; onOpen: (request: TransportRequest) => void }) {
  const chosen = requests.filter((r) => r.transport_date === selectedDay)
  const staff = profile.role !== 'customer'
  return <div className="calendar-page"><section className="surface-card calendar-card"><div className="calendar-legend"><span><i className="legend-dot available"/> Свободно</span><span><i className="legend-dot booked"/> Занято</span><span><i className="legend-dot own"/> Моя заявка</span><span className="slots-note">3 общих слота на дату</span></div><div className="calendar-weekdays">{['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'].map((d) => <div key={d}>{d}</div>)}</div><div className="calendar-grid">{days.map((day) => { const key = iso(day); const inMonth = day.getMonth() === month.getMonth(); const dateRequests = allRequests.filter((r) => r.transport_date === key && r.status !== 'cancelled'); const busySlots = occupancy.filter((r) => r.transport_date === key); const isToday = key === iso(today); return <button key={key} className={`calendar-day ${!inMonth ? 'outside' : ''} ${selectedDay === key ? 'selected' : ''} ${isToday ? 'today' : ''}`} onClick={() => setSelectedDay(key)}><div className="calendar-day-head"><span>{day.getDate()}</span>{busySlots.length > 0 && <em>{busySlots.length}/3</em>}</div><div className="day-slots">{[1, 2, 3].map((slot) => { const found = dateRequests.find((r) => r.slot_number === slot); const busy = busySlots.some((r) => r.slot_number === slot); const own = found?.requester_id === profile.id; if (!busy) return <span key={slot} className="day-slot free" title={`Слот ${slot} свободен`}>{slot}</span>; return <span key={slot} className={`day-slot ${own ? 'own' : 'busy'} ${found ? statusClasses[found.status] : ''}`} title={found ? `Слот ${slot}: ${statusNames[found.status]}` : `Слот ${slot} занят`}>{slot}</span> })}</div></button> })}</div><div className="calendar-foot"><span><span className="online-dot"/> Занято слотов: {occupancy.length}</span><span>Выберите дату, чтобы посмотреть заявки</span></div></section><section className="surface-card selected-day-card"><div className="card-heading"><div><h3>{dateLabel(selectedDay)}</h3><p>Заявки на выбранную дату</p></div><div className="day-count">{chosen.length}<small>заявок</small></div></div><div className="selected-slots">{[1, 2, 3].map((slot) => { const r = allRequests.find((x) => x.transport_date === selectedDay && x.slot_number === slot && x.status !== 'cancelled'); const isBusy = occupancy.some((x) => x.transport_date === selectedDay && x.slot_number === slot); const own = r?.requester_id === profile.id; return <div key={slot} className={`selected-slot ${isBusy ? 'has-request' : 'empty-slot'}`}><div className="selected-slot-number">{slot}</div>{r ? <><div className="selected-slot-info"><strong>{resolveUnit(units, r.from_unit_id, r.from_other_address)} <ArrowRight size={13}/> {resolveUnit(units, r.to_unit_id, r.to_other_address)}</strong><small>№{r.request_no} · {r.capacity_tons} т · {r.profiles?.username || 'Сотрудник'}</small></div><div className="selected-slot-actions"><StatusBadge status={r.status}/>{(staff || (own && r.status === 'created')) && <button className="icon-button small" onClick={() => onOpen(r)} title="Открыть заявку"><Pencil size={14}/></button>}</div></> : isBusy ? <><div className="selected-slot-info"><strong>Слот занят</strong><small>Время зарезервировано другой заявкой</small></div></> : <><div className="selected-slot-info"><strong>Слот свободен</strong><small>Нет активной заявки на эту дату</small></div>{profile.role === 'customer' && <button className="button button-outline button-compact" onClick={() => onCreate(slot)}><Plus size={14}/> Заявка</button>}</>}</div> })}</div><div className="selected-day-tip"><CircleHelp size={15}/>{profile.role === 'customer' ? 'Вы можете создать заявку в свободном слоте. После создания изменить её можно до обработки.' : 'Вы можете открыть заявку, изменить её данные или обновить статус в разделе «Заявки».'}</div></section></div>
}

function RequestsView({ requests, units, profile, search, setSearch, statusFilter, setStatusFilter, onStatus, onEdit, onCancel }: { requests: TransportRequest[]; units: BusinessUnit[]; profile: Profile; search: string; setSearch: (v: string) => void; statusFilter: 'all' | RequestStatus; setStatusFilter: (v: 'all' | RequestStatus) => void; onStatus: (r: TransportRequest, s: RequestStatus) => void; onEdit: (r: TransportRequest) => void; onCancel: (r: TransportRequest) => void }) {
  const staff = profile.role !== 'customer'
  function exportCsv() {
    const headers = ['Номер заявки', 'Дата', 'Слот', 'БЕ', 'Откуда', 'Куда', 'Заказчик', 'Грузоподъёмность, т', 'Погрузка', 'Груз', 'Статус']
    const rows = requests.map((r) => [r.request_no, r.transport_date, r.slot_number, r.business_units?.code || '', resolveUnit(units, r.from_unit_id, r.from_other_address), resolveUnit(units, r.to_unit_id, r.to_other_address), r.profiles?.username || '', r.capacity_tons, r.loading_type === 'rear' ? 'Задняя' : 'Боковая', (r.request_cargo || []).map((c) => cargoNames[c.cargo_type] || c.cargo_type).join('; '), statusNames[r.status]])
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map(escape).join(';')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a'); link.href = url; link.download = `akson-transport-requests-${iso(today)}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  return <div className="requests-page"><section className="surface-card filters-card"><div className="search-field"><Search size={17}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по номеру, маршруту или логину"/></div><div className="filter-select"><Filter size={16}/><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | RequestStatus)}><option value="all">Все статусы</option>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><span className="results-count">Найдено: <strong>{requests.length}</strong></span><button className="button button-secondary button-compact" onClick={exportCsv} disabled={!requests.length}><FileSpreadsheet size={14}/> Выгрузить CSV</button></section>{requests.length ? <section className="surface-card table-card"><div className="table-scroll"><table className="requests-table"><thead><tr><th>Заявка</th><th>Дата / слот</th><th>Маршрут</th><th>Заказчик</th><th>Параметры</th><th>Статус</th><th>Действия</th></tr></thead><tbody>{requests.map((r) => <tr key={r.id}><td><strong className="request-number">№{r.request_no}</strong><small>Транспорт</small></td><td><strong>{dateLabel(r.transport_date, { day: 'numeric', month: 'short' })}</strong><small>Слот {r.slot_number}</small></td><td><div className="table-route"><strong>{resolveUnit(units, r.from_unit_id, r.from_other_address)}</strong><ArrowRight size={13}/><strong>{resolveUnit(units, r.to_unit_id, r.to_other_address)}</strong></div><small>{r.business_units?.code || 'БЕ'}</small></td><td><strong>{r.profiles?.username || profile.username}</strong><small>{roleNames.customer}</small></td><td><strong>{r.capacity_tons} т</strong><small>{r.loading_type === 'rear' ? 'Задняя' : 'Боковая'} погрузка</small></td><td>{staff ? <select className={`status-select ${statusClasses[r.status]}`} value={r.status} onChange={(e) => onStatus(r, e.target.value as RequestStatus)}>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select> : <StatusBadge status={r.status}/>}</td><td><div className="row-actions"><button className="icon-button small" onClick={() => onEdit(r)} title="Подробнее / изменить" disabled={!staff && r.status !== 'created'}><Pencil size={14}/></button>{staff && r.status !== 'cancelled' && <button className="icon-button small danger-icon" onClick={() => onCancel(r)} title="Отменить заявку"><Ban size={14}/></button>}</div></td></tr>)}</tbody></table></div></section> : <section className="surface-card empty-large"><EmptyState icon={Search} title="Заявки не найдены" text="Измените параметры поиска или выберите другой статус."/></section>}</div>
}

function UsersView({ people, units, currentUserId, formOpen, setFormOpen, draft, setDraft, onSubmit, onToggle, saving }: { people: Profile[]; units: BusinessUnit[]; currentUserId: string; formOpen: boolean; setFormOpen: (v: boolean) => void; draft: { username: string; password: string; role: Role; business_unit_id: string; default_from_id: string }; setDraft: (v: any) => void; onSubmit: (e: FormEvent) => void; onToggle: (p: Profile) => void; saving: boolean }) {
  return <div className="admin-page"><div className="admin-summary-row"><div className="admin-summary"><Users size={19}/><div><strong>{people.length}</strong><small>Всего учётных записей</small></div></div><div className="admin-summary"><CheckCircle2 size={19}/><div><strong>{people.filter((p) => p.is_active).length}</strong><small>Активных пользователей</small></div></div><div className="admin-summary"><Ban size={19}/><div><strong>{people.filter((p) => !p.is_active).length}</strong><small>Заблокировано</small></div></div><button className="button button-primary" onClick={() => setFormOpen(!formOpen)}><Plus size={16}/>{formOpen ? 'Скрыть форму' : 'Создать пользователя'}</button></div>{formOpen && <section className="surface-card admin-form-card"><div className="card-heading"><div><h3>Новая учётная запись</h3><p>Логин и пароль для входа в портал</p></div><button className="icon-button" onClick={() => setFormOpen(false)}><X size={17}/></button></div><form className="admin-form-grid" onSubmit={onSubmit}><label>Логин<input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} pattern="[A-Za-z0-9_-]{3,40}" minLength={3} maxLength={40} placeholder="IVANOV01" required/><small>3–40 символов: латиница, цифры, дефис, подчёркивание</small></label><label>Пароль<input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} minLength={12} placeholder="Не менее 12 символов" required/><small>Пароль не показывается повторно после создания</small></label><label>Роль<select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role, business_unit_id: e.target.value === 'customer' ? draft.business_unit_id : '' })}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Бизнес-единица {draft.role === 'customer' && <em>*</em>}<select value={draft.business_unit_id} onChange={(e) => setDraft({ ...draft, business_unit_id: e.target.value })}><option value="">Не назначена</option>{units.filter((u) => u.kind === 'BE' && u.is_active).map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}</select></label><label>БЕ по умолчанию (откуда)<select value={draft.default_from_id} onChange={(e) => setDraft({ ...draft, default_from_id: e.target.value })}><option value="">Не задана</option>{units.filter((u) => u.kind === 'BE' && u.is_active).map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}</select></label><div className="form-submit"><button className="button button-primary" disabled={saving}>{saving ? 'Создаём…' : 'Создать учётную запись'}</button></div></form><div className="admin-form-note"><ShieldCheck size={15}/> Для создания используется защищённая Edge Function. Секретный ключ Supabase не передаётся в браузер.</div></section>}<section className="surface-card table-card"><div className="card-heading table-card-heading"><div><h3>Пользователи портала</h3><p>Управление доступом сотрудников</p></div><span className="table-total">{people.length} записей</span></div><div className="table-scroll"><table className="requests-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Бизнес-единица</th><th>Статус</th><th>Доступ</th></tr></thead><tbody>{people.map((person) => <tr key={person.id}><td><div className="user-cell"><div className="avatar">{person.username.slice(0, 1).toUpperCase()}</div><div><strong>{person.username}</strong><small>{person.id.slice(0, 8)}…</small></div></div></td><td><span className="role-pill">{roleNames[person.role]}</span></td><td>{units.find((u) => u.id === person.business_unit_id)?.code || '—'}</td><td><span className={`access-state ${person.is_active ? 'enabled' : 'disabled'}`}><i/>{person.is_active ? 'Активен' : 'Отключён'}</span></td><td><button className={`button button-compact ${person.is_active ? 'button-muted-danger' : 'button-outline'}`} onClick={() => onToggle(person)} disabled={person.id === currentUserId}>{person.is_active ? 'Отключить' : 'Включить'}</button></td></tr>)}</tbody></table></div></section></div>
}

function DirectoryView({ units, formOpen, setFormOpen, draft, setDraft, onSubmit, onToggle, saving }: { units: BusinessUnit[]; formOpen: boolean; setFormOpen: (v: boolean) => void; draft: UnitDraft; setDraft: (v: UnitDraft) => void; onSubmit: (e: FormEvent) => void; onToggle: (u: BusinessUnit) => void; saving: boolean }) {
  return <div className="directory-page"><div className="directory-top"><div className="directory-stats"><div><strong>{units.filter((u) => u.kind === 'BE').length}</strong><span>Бизнес-единиц</span></div><div><strong>{units.filter((u) => u.kind === 'RC').length}</strong><span>Распределительных центров</span></div></div><button className="button button-primary" onClick={() => setFormOpen(!formOpen)}><Plus size={16}/>{formOpen ? 'Закрыть' : 'Добавить в справочник'}</button></div>{formOpen && <section className="surface-card admin-form-card"><div className="card-heading"><div><h3>Новая запись справочника</h3><p>Добавление бизнес-единицы или РЦ</p></div><button className="icon-button" onClick={() => setFormOpen(false)}><X size={17}/></button></div><form className="admin-form-grid" onSubmit={onSubmit}><label>Код<input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} maxLength={30} placeholder="MSK01" required/></label><label>Название<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} placeholder="Название подразделения" required/></label><label>Тип<select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'BE' | 'RC' })}><option value="BE">Бизнес-единица</option><option value="RC">Распределительный центр</option></select></label><label>Адрес<input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="Город, улица, дом"/></label><div className="form-submit"><button className="button button-primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Добавить запись'}</button></div></form></section>}<div className="directory-grid">{(['BE', 'RC'] as const).map((kind) => <section className="surface-card directory-card" key={kind}><div className="card-heading"><div><h3>{kind === 'BE' ? 'Бизнес-единицы' : 'Распределительные центры'}</h3><p>{units.filter((u) => u.kind === kind).length} записей</p></div><div className={`directory-icon ${kind === 'BE' ? 'be' : 'rc'}`}>{kind === 'BE' ? <Building2 size={18}/> : <Warehouse size={18}/>}</div></div><div className="unit-list">{units.filter((u) => u.kind === kind).map((unit) => <div className="unit-row" key={unit.id}><div className="unit-code">{unit.code.slice(0, 3)}</div><div className="unit-copy"><strong>{unit.code} · {unit.name}</strong><small>{unit.address || 'Адрес не указан'}</small></div><span className={`unit-state ${unit.is_active ? 'active' : 'inactive'}`}>{unit.is_active ? 'Активна' : 'Неактивна'}</span><button className="icon-button small" onClick={() => onToggle(unit)} title={unit.is_active ? 'Деактивировать' : 'Активировать'}>{unit.is_active ? <Ban size={14}/> : <Check size={14}/>}</button></div>)}{!units.some((u) => u.kind === kind) && <div className="unit-empty">В этом разделе пока нет записей.</div>}</div></section>)}</div></div>
}

function RequestModal({ units, profile, occupancy, request, slot, onClose, onSave, saving }: { units: BusinessUnit[]; profile: Profile; occupancy: SlotOccupancy[]; request?: TransportRequest; slot?: number; onClose: () => void; onSave: (payload: RequestDraft, request?: TransportRequest) => Promise<void>; saving: boolean }) {
  const [date, setDate] = useState(request?.transport_date || iso(today))
  const [slotNo, setSlotNo] = useState(request?.slot_number || slot || 1)
  const [from, setFrom] = useState(request?.from_unit_id || profile.default_from_id || profile.business_unit_id || '')
  const [fromOther, setFromOther] = useState(request?.from_other_address || '')
  const [to, setTo] = useState(request?.to_unit_id || '')
  const [toOther, setToOther] = useState(request?.to_other_address || '')
  const [capacity, setCapacity] = useState(String(request?.capacity_tons || '5'))
  const [loadingType, setLoadingType] = useState<'rear' | 'side'>(request?.loading_type || 'rear')
  const [cargo, setCargo] = useState<string[]>(request?.request_cargo?.map((x) => x.cargo_type) || [])
  const [stock, setStock] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'goods')?.stock_pallets || 0))
  const [kdk, setKdk] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'goods')?.kdk_pallets || 0))
  const [packaging, setPackaging] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'packaging')?.packaging_qty || 0))
  const [formError, setFormError] = useState('')
  const be = units.filter((u) => u.kind === 'BE' && u.is_active)
  const destinations = units.filter((u) => u.is_active)
  const occupied = occupancy.some((r) => r.transport_date === date && r.slot_number === slotNo && !(request?.transport_date === date && request.slot_number === slotNo))
  const canEdit = profile.role !== 'customer' || (!!request && request.requester_id === profile.id && request.status === 'created')
  function toggleCargo(value: string) { setCargo((old) => old.includes(value) ? old.filter((x) => x !== value) : [...old, value]) }
  async function submit(event: FormEvent) {
    event.preventDefault(); setFormError('')
    try {
      if (!canEdit) throw new Error('У вас нет прав на изменение этой заявки.')
      if (!from || !to || (from === 'other' && !fromOther.trim()) || (to === 'other' && !toOther.trim())) throw new Error('Заполните маршрут перевозки.')
      if (!cargo.length) throw new Error('Выберите хотя бы один вид груза.')
      if (occupied) throw new Error('Этот слот уже занят. Выберите другой слот или дату.')
      if (cargo.includes('goods') && Number(stock) + Number(kdk) <= 0) throw new Error('Укажите количество паллет Сток и/или КДК.')
      if (cargo.includes('packaging') && Number(packaging) <= 0) throw new Error('Укажите количество тары.')
      await onSave({ transport_date: date, slot_number: slotNo, from_unit_id: from === 'other' ? null : from, from_other_address: from === 'other' ? fromOther.trim() : null, to_unit_id: to === 'other' ? null : to, to_other_address: to === 'other' ? toOther.trim() : null, capacity_tons: Number(capacity), loading_type: loadingType, cargo_types: cargo, stock_pallets: Number(stock || 0), kdk_pallets: Number(kdk || 0), packaging_qty: Number(packaging || 0) }, request)
    } catch (e) { setFormError(errorText(e)) }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="request-modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}><div className="modal-heading"><div><span className="modal-eyebrow">ТРАНСПОРТНАЯ ЗАЯВКА</span><h2>{request ? `Заявка №${request.request_no}` : 'Новая заявка'}</h2><p>{profile.username} · {request ? 'Редактирование данных' : 'Заполните параметры перевозки'}</p></div><button type="button" className="icon-button" onClick={onClose}><X size={18}/></button></div><div className="modal-body"><div className="form-section-label">Дата и слот</div><div className="form-grid-two"><label>Дата перевозки<input type="date" value={date} onChange={(e) => setDate(e.target.value)} required disabled={!canEdit}/></label><label>Транспортный слот<select value={slotNo} onChange={(e) => setSlotNo(Number(e.target.value))} disabled={!canEdit}>{[1, 2, 3].map((n) => <option value={n} key={n}>Слот {n}</option>)}</select></label></div><div className="form-section-label">Маршрут</div><div className="form-grid-two"><label>Откуда<select value={from} onChange={(e) => setFrom(e.target.value)} required disabled={!canEdit}><option value="">Выберите БЕ</option>{be.map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}<option value="other">Другой адрес</option></select></label>{from === 'other' && <label>Адрес отправления<input value={fromOther} onChange={(e) => setFromOther(e.target.value)} required disabled={!canEdit}/></label>}<label>Куда<select value={to} onChange={(e) => setTo(e.target.value)} required disabled={!canEdit}><option value="">Выберите БЕ или РЦ</option>{destinations.map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}<option value="other">Другой адрес</option></select></label>{to === 'other' && <label>Адрес назначения<input value={toOther} onChange={(e) => setToOther(e.target.value)} required disabled={!canEdit}/></label>}</div><div className="form-section-label">Параметры транспорта</div><div className="form-grid-two"><div className="field-block"><span>Грузоподъёмность</span><div className="segmented-options">{['1.5', '5', '10', '20'].map((value) => <button type="button" key={value} className={capacity === value ? 'selected' : ''} onClick={() => setCapacity(value)} disabled={!canEdit}>{value.replace('.', ',')} т</button>)}</div></div><div className="field-block"><span>Тип погрузки</span><div className="segmented-options">{[['rear', 'Задняя'], ['side', 'Боковая']].map(([value, label]) => <button type="button" key={value} className={loadingType === value ? 'selected' : ''} onClick={() => setLoadingType(value as 'rear' | 'side')} disabled={!canEdit}>{label}</button>)}</div></div></div><div className="form-section-label">Состав груза</div><div className="cargo-tiles">{[['goods', 'Товар', Package], ['equipment', 'Оборудование', Warehouse], ['packaging', 'Тара', Layers3]].map(([value, label, Icon]: any) => <button type="button" key={value} className={cargo.includes(value) ? 'cargo-tile active' : 'cargo-tile'} onClick={() => toggleCargo(value)} disabled={!canEdit}><Icon size={23}/><strong>{label}</strong><span>{cargo.includes(value) ? 'Выбрано' : 'Добавить'}</span></button>)}</div>{(cargo.includes('goods') || cargo.includes('packaging')) && <div className="form-grid-two cargo-quantities">{cargo.includes('goods') && <><label>Сток, паллетомест<input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} disabled={!canEdit}/></label><label>КДК, паллетомест<input type="number" min="0" value={kdk} onChange={(e) => setKdk(e.target.value)} disabled={!canEdit}/></label></>}{cargo.includes('packaging') && <label>Количество тары<input type="number" min="1" value={packaging} onChange={(e) => setPackaging(e.target.value)} disabled={!canEdit}/></label>}</div>}{occupied && <div className="message message-error"><AlertCircle size={16}/> Этот слот уже занят другой заявкой.</div>}{formError && <div className="message message-error"><AlertCircle size={16}/>{formError}</div>}</div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Закрыть</button>{canEdit && <button className="button button-primary" disabled={saving || !!occupied}>{saving ? 'Сохранение…' : 'Сохранить заявку'} <ArrowRight size={16}/></button>}</div></form></div>
}

function MonthControls({ month, setMonth }: { month: Date; setMonth: (v: Date) => void }) {
  return <div className="month-controls"><button className="icon-button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={17}/></button><strong>{monthTitle(month)}</strong><button className="icon-button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={17}/></button></div>
}
function StatusBadge({ status }: { status: RequestStatus }) { return <span className={`status-badge ${statusClasses[status]}`}><i/>{statusNames[status]}</span> }
function EmptyState({ icon: Icon, title, text }: { icon: typeof Search; title: string; text: string }) { return <div className="empty-state"><div><Icon size={25}/></div><strong>{title}</strong><p>{text}</p></div> }
function resolveUnit(units: BusinessUnit[], id: string | null, other: string | null) { if (other) return other; const unit = units.find((u) => u.id === id); return unit ? `${unit.code}` : 'Не указано' }

export default App
