import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertCircle, ArrowRight, ArrowUpRight,
  Building2, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  CircleHelp, FileSpreadsheet, Filter, LayoutDashboard, LogOut, Menu, Moon,
  Package, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sun, Truck, Users,
  Warehouse, X, Pencil, Ban, Eye, Layers3, History as HistoryIcon, Save,
  SlidersHorizontal, Clock3, Upload, Download, FileText, MapPin, CalendarClock, Copy, BookOpen, Bell
} from 'lucide-react'
import { supabase, supabaseConfigured } from './lib/supabase'
import type { BusinessUnit, CargoLine, Profile, RequestStatus, Role, TransportRequest } from './types'

type View = 'overview' | 'calendar' | 'requests' | 'reports' | 'users' | 'directory' | 'settings' | 'history' | 'instructions'
type RequestListFilter = 'all' | 'active' | RequestStatus
type RequestDraft = {
  transport_date: string; slot_number: number; slot_type: 'main' | 'reserve'; from_unit_id: string | null; from_other_address: string | null;
  to_unit_id: string | null; to_other_address: string | null; capacity_tons: number; loading_type: 'rear' | 'side';
  cargo_types: string[]; stock_pallets: number; kdk_pallets: number; packaging_qty: number; equipment_pallet_places: number; requester_id?: string; registry_file?: File | null; transport_task_number: string; request_comment: string
}
type UnitDraft = { id?: string | null; code: string; name: string; kind: 'BE' | 'RC'; address: string }
type AuditRecord = { id: number; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; details: Record<string, any>; created_at: string; actor_username?: string | null }
type RoleLimitValues = Record<Role, string>
type SlotOccupancy = { transport_date: string; slot_number: number; slot_type: 'main' | 'reserve' }
type CalendarSlot = { transport_date: string; slot_number: number; slot_type: 'main' | 'reserve'; status: RequestStatus; from_be_code: string }
type ReportRow = { section: 'summary' | 'customer' | 'from' | 'to' | 'cargo' | 'closing_speed' | 'status'; label: string; request_count: number; average_close_days: number | null; closed_count: number; open_count: number }
type UserNotification = { id: string; user_id: string; request_id: string | null; notification_type: string; title: string; body: string; created_at: string; read_at: string | null }
const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY || '') as string
const base64UrlToBytes = (value: string) => { const padded = value + '='.repeat((4 - value.length % 4) % 4); const base64 = padded.replace(/-/g, '+').replace(/_/g, '/'); const raw = window.atob(base64); return Uint8Array.from(raw, (char) => char.charCodeAt(0)) }

const roleNames: Record<Role, string> = { customer: 'Заказчик', dispatcher: 'Диспетчер', utz: 'УТЗ', admin: 'Администратор' }
const roleDescriptions: Record<Role, string> = {
  customer: 'Создание, просмотр и отмена своих заявок до начала обработки',
  dispatcher: 'Редактирование всех заявок, управление статусами и история',
  utz: 'Просмотр и контроль всех заявок без редактирования',
  admin: 'Полное администрирование портала'
}
const statusNames: Record<RequestStatus, string> = { created: 'Создана', search: 'Поиск транспорта', confirmed: 'Подтверждена', completed: 'Выполнена', cancelled: 'Отменена' }
const statusClasses: Record<RequestStatus, string> = { created: 'status-created', search: 'status-search', confirmed: 'status-confirmed', completed: 'status-completed', cancelled: 'status-cancelled' }
const cargoNames: Record<string, string> = { goods: 'Товар', equipment: 'Оборудование', packaging: 'Тара' }
const moscowTodayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
const moscowToday = { year: Number(moscowTodayParts.find((part) => part.type === 'year')?.value), month: Number(moscowTodayParts.find((part) => part.type === 'month')?.value), day: Number(moscowTodayParts.find((part) => part.type === 'day')?.value) }
const today = new Date(moscowToday.year, moscowToday.month - 1, moscowToday.day)
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const monthTitle = (d: Date) => d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
const dateLabel = (value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }) => new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU', options)
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Не удалось выполнить операцию. Попробуйте ещё раз.'
const matchesAllTerms = (text: string, query: string) => { const terms = query.toLocaleLowerCase('ru-RU').trim().split(/\s+/).filter(Boolean); const normalized = text.toLocaleLowerCase('ru-RU'); return terms.every((term) => normalized.includes(term)) }

function App() {
  const [session, setSession] = useState<any>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const realtimeRefreshTimer = useRef<number | null>(null)
  const notificationToastTimer = useRef<number | null>(null)
  const loadedProfileIdRef = useRef<string | null>(null)
  const [units, setUnits] = useState<BusinessUnit[]>([])
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [occupancy, setOccupancy] = useState<SlotOccupancy[]>([])
  const [calendarSlots, setCalendarSlots] = useState<CalendarSlot[]>([])
  const [searchRequests, setSearchRequests] = useState<TransportRequest[]>([])
  const [people, setPeople] = useState<Profile[]>([])
  const [view, setView] = useState<View>(() => {
    try {
      const saved = sessionStorage.getItem('akson-transport-active-view') as View | null
      return saved || 'overview'
    } catch { return 'overview' }
  })
  const [month, setMonth] = useState(new Date(today.getFullYear(), today.getMonth(), 1))
  const [selectedDay, setSelectedDay] = useState(iso(today))
  const [requestModal, setRequestModal] = useState<{ open: boolean; request?: TransportRequest; slot?: number; date?: string }>({ open: false })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false)
  const [notificationToast, setNotificationToast] = useState<UserNotification | null>(null)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [requesterFilter, setRequesterFilter] = useState('')
  const [fromFilter, setFromFilter] = useState('')
  const [toFilter, setToFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<RequestListFilter>('all')
  const [showCancelled, setShowCancelled] = useState(false)
  const [showPrevious30Days, setShowPrevious30Days] = useState(false)
  const [reserveSlotLimit, setReserveSlotLimit] = useState('3')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('akson-transport-theme') === 'dark' ? 'dark' : 'light' } catch { return 'light' }
  })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showUserForm, setShowUserForm] = useState(false)
  const [userDraft, setUserDraft] = useState({ username: '', password: '', role: 'customer' as Role, business_unit_id: '', default_from_id: '' })
  const [unitDraft, setUnitDraft] = useState<UnitDraft>({ id: null, code: '', name: '', kind: 'BE', address: '' })
  const [unitFormOpen, setUnitFormOpen] = useState(false)
  const [editingPerson, setEditingPerson] = useState<Profile | null>(null)
  const [userEditDraft, setUserEditDraft] = useState({ username: '', password: '', role: 'customer' as Role, business_unit_id: '', default_from_id: '', is_active: true })
  const [bookingAdvanceDays, setBookingAdvanceDays] = useState('0')
  const [registryTemplatePath, setRegistryTemplatePath] = useState<string | null>(null)
  const [registryTemplateName, setRegistryTemplateName] = useState<string | null>(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const [roleLimits, setRoleLimits] = useState<RoleLimitValues>({ customer: '30', dispatcher: '30', utz: '30', admin: '30' })
  const [auditRows, setAuditRows] = useState<AuditRecord[]>([])
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [historyEntity, setHistoryEntity] = useState('all')
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [reportsFrom, setReportsFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [reportsTo, setReportsTo] = useState(iso(today))
  const [reportRows, setReportRows] = useState<ReportRow[]>([])
  const [reportsLoading, setReportsLoading] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('akson-transport-theme', theme) } catch { /* private browsing */ }
  }, [theme])
  useEffect(() => {
    try { sessionStorage.setItem('akson-transport-active-view', view) } catch { /* storage may be disabled */ }
  }, [view])
  // Native hover hints are applied to every input, selector and action button.
  // Explicit, hand-written title attributes always take precedence.
  useEffect(() => {
    if (!profile) return
    const root = document.querySelector('.app-shell')
    if (!root) return
    const addHints = () => {
      root.querySelectorAll<HTMLElement>('button:not([title]), input:not([title]), select:not([title]), textarea:not([title])').forEach((control) => {
        const aria = control.getAttribute('aria-label') || ''
        const placeholder = control.getAttribute('placeholder') || ''
        const label = control.closest('label')?.textContent?.replace(/\s+/g, ' ').trim() || ''
        const caption = control.tagName === 'BUTTON'
          ? (aria || control.textContent?.replace(/\s+/g, ' ').trim() || 'Действие')
          : (label || placeholder || (control.tagName === 'SELECT' ? 'Список выбора' : 'Поле ввода'))
        control.title = control.tagName === 'BUTTON' ? `Действие: ${caption}` : `Поле: ${caption}. Наведите курсор, чтобы прочитать подсказку.`
      })
    }
    addHints()
    const observer = new MutationObserver(addHints)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [profile, view, requestModal.open, showUserForm, unitFormOpen, editingPerson])

  useEffect(() => {
    if (!supabase) return
    let alive = true
    supabase.auth.getSession().then(({ data }) => { if (alive) setSession(data.session) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => { alive = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!session || !supabase) { setProfile(null); setPeople([]); loadedProfileIdRef.current = null; return }
    let alive = true
    supabase.from('profiles').select('*').eq('id', session.user.id).single().then(async ({ data, error: profileError }) => {
      if (!alive) return
      if (profileError || !data) { setError(`Не удалось загрузить профиль: ${profileError?.message || 'профиль не найден'}`); return }
      if (!data.is_active) { await supabase?.auth.signOut(); setError('Учётная запись заблокирована администратором.'); return }
      if (loadedProfileIdRef.current !== data.id) {
        loadedProfileIdRef.current = data.id
        let savedView: View | null = null
        try { savedView = sessionStorage.getItem('akson-transport-active-view') as View | null } catch { /* storage may be disabled */ }
        const allowedViews: Record<Role, View[]> = {
          customer: ['calendar', 'requests', 'instructions'],
          utz: ['calendar', 'requests', 'instructions'],
          dispatcher: ['overview', 'calendar', 'requests', 'reports', 'history', 'instructions'],
          admin: ['overview', 'calendar', 'requests', 'reports', 'users', 'directory', 'settings', 'history', 'instructions']
        }
        const defaultView: View = data.role === 'customer' || data.role === 'utz' ? 'calendar' : 'overview'
        setView(savedView && allowedViews[data.role as Role]?.includes(savedView) ? savedView : defaultView)
      }
      setProfile(data as Profile)
      setError('')
    })
    return () => { alive = false }
  }, [session])

  useEffect(() => { if (profile) void loadData() }, [profile, month, showPrevious30Days])

  // Receive a minimal server-side broadcast when any request changes.
  // The message carries no request data; each role reloads through its own RLS scope.
  useEffect(() => {
    if (!profile || !supabase) return
    // Capture the non-null client in this effect scope. TypeScript does not
    // preserve narrowing of the imported nullable binding inside cleanup.
    const client = supabase
    const channel = client
      .channel('transport-calendar', { config: { private: true } })
      .on('broadcast', { event: 'transport-request-updated' }, () => {
        if (realtimeRefreshTimer.current !== null) window.clearTimeout(realtimeRefreshTimer.current)
        realtimeRefreshTimer.current = window.setTimeout(() => {
          realtimeRefreshTimer.current = null
          void loadData()
        }, 180)
      })
      .subscribe()
    return () => {
      if (realtimeRefreshTimer.current !== null) window.clearTimeout(realtimeRefreshTimer.current)
      realtimeRefreshTimer.current = null
      void client.removeChannel(channel)
    }
  }, [profile?.id, month.getTime(), showPrevious30Days])
  useEffect(() => {
    if (!profile || !supabase) { setNotifications([]); setPushEnabled(false); return }
    const client = supabase
    let active = true
    void loadNotifications()
    const channel = client
      .channel(`user-notifications:${profile.id}`, { config: { private: true } })
      .on('broadcast', { event: 'user-notification-created' }, async (message) => {
        const id = String((message as any)?.payload?.id || '')
        if (!id || !active) return
        const { data } = await client.from('user_notifications').select('*').eq('id', id).maybeSingle()
        if (!active || !data) return
        setNotifications((current) => [data as UserNotification, ...current.filter((item) => item.id !== id)].slice(0, 30))
        setNotificationToast(data as UserNotification)
        if (notificationToastTimer.current !== null) window.clearTimeout(notificationToastTimer.current)
        notificationToastTimer.current = window.setTimeout(() => setNotificationToast(null), 6500)
      })
      .subscribe()

    // Re-associate an existing browser subscription with the currently signed-in account.
    void (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !VAPID_PUBLIC_KEY) return
      try {
        const registration = await navigator.serviceWorker.register('/sw.js')
        const existing = await registration.pushManager.getSubscription()
        if (!existing || !active) return
        const keys = existing.toJSON().keys || {}
        if (!keys.p256dh || !keys.auth) return
        const { error: rpcError } = await client.rpc('register_push_subscription', {
          p_endpoint: existing.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth
        })
        if (!rpcError && active) setPushEnabled(Notification.permission === 'granted')
      } catch (e) { console.warn('Не удалось восстановить push-подписку:', e) }
    })()

    return () => {
      active = false
      if (notificationToastTimer.current !== null) window.clearTimeout(notificationToastTimer.current)
      notificationToastTimer.current = null
      void client.removeChannel(channel)
    }
  }, [profile?.id])
  useEffect(() => {
    if (!profile) return
    void loadSettings()
    if (profile.role === 'admin' || profile.role === 'dispatcher') void loadPeople()
  }, [profile])
  useEffect(() => {
    if (!profile || !['dispatcher', 'admin'].includes(profile.role) || view !== 'history') return
    const timer = window.setTimeout(() => { void loadHistory() }, 250)
    return () => window.clearTimeout(timer)
  }, [profile, view, historySearch, historyEntity, historyFrom, historyTo])
  useEffect(() => {
    if (profile && ['dispatcher', 'admin'].includes(profile.role) && view === 'reports' && reportRows.length === 0) {
      void loadReports()
    }
  }, [profile, view])

  async function loadNotifications() {
    if (!supabase || !profile) return
    const { data, error: notificationError } = await supabase
      .from('user_notifications').select('*').order('created_at', { ascending: false }).limit(30)
    if (!notificationError && data) setNotifications(data as UserNotification[])
  }

  async function markNotificationRead(notification: UserNotification) {
    if (!supabase || notification.read_at) return
    const readAt = new Date().toISOString()
    const { error: updateError } = await supabase.from('user_notifications').update({ read_at: readAt }).eq('id', notification.id)
    if (!updateError) setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: readAt } : item))
  }

  async function markAllNotificationsRead() {
    if (!supabase) return
    const unreadIds = notifications.filter((item) => !item.read_at).map((item) => item.id)
    if (!unreadIds.length) return
    const readAt = new Date().toISOString()
    const { error: updateError } = await supabase.from('user_notifications').update({ read_at: readAt }).in('id', unreadIds)
    if (!updateError) setNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at || readAt })))
  }

  async function enableBrowserPush() {
    if (!supabase || !profile) return
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setNotice('Этот браузер не поддерживает push-уведомления. Используйте актуальную версию Chrome или Edge.')
      return
    }
    if (!VAPID_PUBLIC_KEY) {
      setNotice('Push-уведомления ещё не настроены: добавьте VITE_VAPID_PUBLIC_KEY в переменные Vercel и выполните повторный деплой.')
      return
    }
    setPushBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('Разрешение на уведомления не предоставлено в настройках браузера.')
      const registration = await navigator.serviceWorker.register('/sw.js')
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(VAPID_PUBLIC_KEY) })
      const keys = subscription.toJSON().keys || {}
      if (!keys.p256dh || !keys.auth) throw new Error('Браузер не вернул ключи push-подписки. Повторите включение.')
      const { error: rpcError } = await supabase.rpc('register_push_subscription', {
        p_endpoint: subscription.endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth
      })
      if (rpcError) throw rpcError
      setPushEnabled(true)
      setNotice('Браузерные push-уведомления включены на этом устройстве.')
    } catch (e) {
      setNotice(errorText(e))
    } finally { setPushBusy(false) }
  }

  async function loadData(targetMonth: Date = month) {
    if (!supabase || !profile) return
    setLoading(true); setError('')
    // The calendar itself is always a rolling 30-day window starting today.
    // Keep the separately selected month window as well for the Requests page,
    // whose month controls remain independent from the calendar.
    const first = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1)
    const offset = (first.getDay() + 6) % 7
    const requestGridStart = new Date(first); requestGridStart.setDate(first.getDate() - offset)
    const requestGridEnd = new Date(requestGridStart); requestGridEnd.setDate(requestGridStart.getDate() + 41)
    // Match DockSlot's calendar geometry: start on Monday and end on Sunday,
    // while keeping the operational window exactly today..today+29.
    const calendarStart = new Date(today)
    if (showPrevious30Days) calendarStart.setDate(calendarStart.getDate() - 30)
    const calendarStartOffset = (calendarStart.getDay() + 6) % 7
    calendarStart.setDate(calendarStart.getDate() - calendarStartOffset)
    const calendarEnd = new Date(today)
    calendarEnd.setDate(calendarEnd.getDate() + 29)
    const calendarEndOffset = (calendarEnd.getDay() + 6) % 7
    calendarEnd.setDate(calendarEnd.getDate() + (6 - calendarEndOffset))
    const from = new Date(Math.min(requestGridStart.getTime(), calendarStart.getTime()))
    const to = new Date(Math.max(requestGridEnd.getTime(), calendarEnd.getTime()))
    const fromDate = iso(from)
    const toDate = iso(to)
    const searchEnd = new Date(today.getFullYear(), today.getMonth() + 3, 0)
    const searchFromDate = iso(today)
    const searchToDate = iso(searchEnd)
    // Fetch all directory rows visible under RLS. Customers can see inactive rows only
    // when they are referenced by their own historical requests, so saved route
    // addresses remain readable after a directory entry is deactivated.
    const unitsQuery = supabase.from('business_units').select('*').order('code')
    const requestsSelect = '*, profiles!transport_requests_requester_id_fkey(username), business_units!transport_requests_business_unit_id_fkey(code,name), request_cargo(cargo_type,stock_pallets,kdk_pallets,packaging_qty,equipment_pallet_places)'
    const [unitResult, requestResult, occupancyResult, calendarSlotResult, searchResult] = await Promise.all([
      unitsQuery,
      supabase.from('transport_requests').select(requestsSelect)
        .gte('transport_date', fromDate).lte('transport_date', toDate).order('transport_date').order('slot_type').order('slot_number'),
      supabase.rpc('get_slot_occupancy', { p_from_date: fromDate, p_to_date: toDate }),
      supabase.rpc('get_calendar_slot_summary', { p_from_date: fromDate, p_to_date: toDate }),
      ['dispatcher', 'admin', 'utz'].includes(profile.role)
        ? supabase.from('transport_requests').select(requestsSelect).gte('transport_date', searchFromDate).lte('transport_date', searchToDate).neq('status', 'cancelled').neq('status', 'completed').order('transport_date').order('slot_type').order('slot_number')
        : Promise.resolve({ data: [], error: null } as any)
    ])
    if (unitResult.error) setError(`Справочник: ${unitResult.error.message}`)
    else setUnits((unitResult.data || []) as BusinessUnit[])
    if (requestResult.error) setError(`Заявки: ${requestResult.error.message}`)
    else setRequests((requestResult.data || []) as TransportRequest[])
    if (searchResult.error) setError(`Поиск по календарю: ${searchResult.error.message}`)
    else setSearchRequests((searchResult.data || []) as TransportRequest[])
    if (occupancyResult.error) setError(`Занятость слотов: ${occupancyResult.error.message}. Проверьте миграцию 0010_split_main_and_reserve_transport_slots.sql.`)
    else setOccupancy((occupancyResult.data || []) as SlotOccupancy[])
    if (calendarSlotResult.error) setError(`Сводка календаря: ${calendarSlotResult.error.message}. Проверьте миграции 0004_role_permissions_calendar_reports.sql и 0010_split_main_and_reserve_transport_slots.sql.`)
    else setCalendarSlots((calendarSlotResult.data || []) as CalendarSlot[])
    setLoading(false)
  }

  async function loadPeople() {
    if (!supabase || !['admin', 'dispatcher'].includes(profile?.role || '')) return
    const { data, error: peopleError } = await supabase.from('profiles')
      .select('id,username,role,business_unit_id,default_from_id,is_active,created_at')
      .order('username')
    if (peopleError) setError(`Пользователи: ${peopleError.message}`)
    else setPeople((data || []) as Profile[])
  }

  async function loadSettings() {
    if (!supabase || !profile) return
    const [settingsResult, limitsResult] = await Promise.all([
      supabase.from('portal_settings').select('booking_advance_days,registry_template_path,registry_template_name,reserve_slot_limit').eq('id', true).maybeSingle(),
      supabase.from('role_request_limits').select('role,max_requests_per_month')
    ])
    if (settingsResult.error) { setError(`Настройки записи: ${settingsResult.error.message}. Проверьте миграции 0003_admin_controls_audit.sql и 0010_split_main_and_reserve_transport_slots.sql.`); return }
    if (settingsResult.data) {
      setBookingAdvanceDays(String(settingsResult.data.booking_advance_days ?? 0))
      setRegistryTemplatePath(settingsResult.data.registry_template_path || null)
      setRegistryTemplateName(settingsResult.data.registry_template_name || null)
      setReserveSlotLimit(String(settingsResult.data.reserve_slot_limit ?? 3))
    }
    if (limitsResult.error) { setError(`Лимиты заявок: ${limitsResult.error.message}. Примените миграцию 0003_admin_controls_audit.sql.`); return }
    const next: RoleLimitValues = { customer: '30', dispatcher: '30', utz: '30', admin: '30' }
    ;(limitsResult.data || []).forEach((row: any) => { if (row.role in next) next[row.role as Role] = String(row.max_requests_per_month) })
    setRoleLimits(next)
  }

  async function loadHistory(loadMore = false) {
    if (!supabase || !profile || !['dispatcher', 'admin'].includes(profile.role) || (loadMore && historyLoadingMore)) return
    if (loadMore) setHistoryLoadingMore(true)
    const offset = loadMore ? auditRows.length : 0
    const { data, error: auditError } = await supabase.rpc('admin_search_audit', {
      p_search: historySearch.trim() || null,
      p_entity_type: historyEntity === 'all' ? null : historyEntity,
      p_from_date: historyFrom || null,
      p_to_date: historyTo || null,
      p_offset: offset,
      p_limit: 500
    })
    if (auditError) setError(`История изменений: ${auditError.message}. Проверьте миграции 0003_admin_controls_audit.sql и 0004_role_permissions_calendar_reports.sql.`)
    else {
      const batch = (data || []) as AuditRecord[]
      setAuditRows((current) => loadMore ? [...current, ...batch] : batch)
      setHistoryHasMore(batch.length === 500)
    }
    if (loadMore) setHistoryLoadingMore(false)
  }

  async function loadReports() {
    if (!supabase || !profile || !['dispatcher', 'admin'].includes(profile.role)) return
    if (!reportsFrom || !reportsTo || reportsFrom > reportsTo) { setError('Начальная дата отчёта не может быть позже конечной.'); return }
    setReportsLoading(true); setError('')
    const { data, error: reportError } = await supabase.rpc('get_transport_report_data', {
      p_from_date: reportsFrom,
      p_to_date: reportsTo
    })
    if (reportError) setError(`Не удалось сформировать отчёт: ${reportError.message}. Проверьте миграцию 0004_role_permissions_calendar_reports.sql.`)
    else setReportRows((data || []) as ReportRow[])
    setReportsLoading(false)
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    if (!supabase || profile?.role !== 'admin') return
    const advance = Number(bookingAdvanceDays)
    const limits = Object.fromEntries(Object.entries(roleLimits).map(([role, value]) => [role, Number(value)])) as Record<Role, number>
    const reserveLimit = Number(reserveSlotLimit)
    if (!Number.isInteger(advance) || advance < 0 || advance > 365) { setError('Срок предварительной записи должен быть от 0 до 365 дней.'); return }
    if (!Number.isInteger(reserveLimit) || reserveLimit < 0 || reserveLimit > 20) { setError('Количество резервных слотов должно быть от 0 до 20.'); return }
    if (Object.entries(limits).some(([, value]) => !Number.isInteger(value) || value < 1 || value > 10000)) { setError('Месячный лимит по каждой роли должен быть от 1 до 10 000 заявок.'); return }
    setSaving(true); setError('')
    const { error: saveError } = await supabase.rpc('admin_save_portal_settings', {
      p_booking_advance_days: advance,
      p_role_limits: limits
    })
    if (saveError) { setSaving(false); setError(`Не удалось сохранить настройки: ${saveError.message}`); return }
    const { data: reserveUpdated, error: reserveError } = await supabase.from('portal_settings').update({ reserve_slot_limit: reserveLimit, updated_at: new Date().toISOString() }).eq('id', true).select('id').maybeSingle()
    setSaving(false)
    if (reserveError || !reserveUpdated) setError(`Не удалось сохранить количество резервных слотов: ${reserveError?.message || 'запись не обновлена'}`)
    else { setNotice('Настройки ограничений и резервных слотов сохранены.'); await loadSettings(); await loadHistory(); await loadData() }
  }

  async function downloadPrivateFile(path: string | null | undefined, fileName?: string | null) {
    if (!supabase || !path) { setError('Файл пока не загружен.'); return }
    const { data, error: signedError } = await supabase.storage.from('dispatch-files').createSignedUrl(path, 60, fileName ? { download: fileName } : { download: true })
    if (signedError || !data?.signedUrl) { setError(`Не удалось получить ссылку на файл: ${signedError?.message || 'ссылка не создана'}`); return }
    const link = document.createElement('a')
    link.href = data.signedUrl
    link.download = fileName || ''
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    document.body.appendChild(link); link.click(); link.remove()
  }

  async function downloadRegistryTemplate() {
    await downloadPrivateFile(registryTemplatePath, registryTemplateName || 'Шаблон_реестра')
  }

  async function exportSelectedRequestsCsv(selectedDates: string[]) {
    const dates = new Set(selectedDates)
    const rows = requests.filter((r) => dates.has(r.transport_date) && (profile?.role !== 'customer' || r.requester_id === profile.id))
      .sort((a, b) => b.request_no - a.request_no)
    if (!rows.length) { setError('На выбранные даты нет заявок для выгрузки.'); return }
    const headers = ['ID заявки','Номер заявки','ID заказчика','Заказчик','ID БЕ заказчика','БЕ заказчика','Наименование БЕ заказчика','Адрес БЕ заказчика','Дата перевозки','Тип слота','Номер слота','ID отправления','Откуда','Адрес отправления','ID назначения','Куда','Адрес назначения','Грузоподъёмность, т','Тип погрузки','Типы груза','Сток, паллетомест','Кросс док, паллетомест','Тара, шт.','Оборудование, паллетомест','Номер задания на перевозку','Комментарий заказчика','Комментарий диспетчера','Путь к реестру','Имя реестра','Статус','Создана','Обновлена']
    const dataRows = rows.map((r) => {
      const cargo = r.request_cargo || []
      const fromUnit = units.find((u) => u.id === r.from_unit_id)
      const toUnit = units.find((u) => u.id === r.to_unit_id)
      const customerUnit = units.find((u) => u.id === r.business_unit_id)
      return [r.id,r.request_no,r.requester_id,r.profiles?.username || '',r.business_unit_id || '',customerUnit?.code || r.business_units?.code || '',customerUnit?.name || r.business_units?.name || '',customerUnit?.address || '',r.transport_date,r.slot_type === 'main' ? 'Основной' : 'Резервный',r.slot_number,r.from_unit_id || '',resolveUnit(units,r.from_unit_id,r.from_other_address),r.from_unit_id ? fromUnit?.address || '' : r.from_other_address || '',r.to_unit_id || '',resolveUnit(units,r.to_unit_id,r.to_other_address),r.to_unit_id ? toUnit?.address || '' : r.to_other_address || '',r.capacity_tons,r.loading_type === 'rear' ? 'Задняя' : 'Боковая',cargo.map((c) => cargoNames[c.cargo_type] || c.cargo_type).join(', '),cargo.find((c) => c.cargo_type === 'goods')?.stock_pallets || 0,cargo.find((c) => c.cargo_type === 'goods')?.kdk_pallets || 0,cargo.find((c) => c.cargo_type === 'packaging')?.packaging_qty || 0,cargo.find((c) => c.cargo_type === 'equipment')?.equipment_pallet_places || 0,r.transport_task_number || '',r.request_comment || '',r.dispatcher_comment || '',r.registry_file_path || '',r.registry_file_name || '',statusNames[r.status],r.created_at || '',r.updated_at || '']
    })
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = '\uFEFF' + [headers, ...dataRows].map((row) => row.map(escape).join(';')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a'); link.href = url; link.download = `akson-transport-requests-${selectedDates.length}-days-${iso(today)}.csv`; link.click(); URL.revokeObjectURL(url)
  }

  async function exportSelectedRegistries(selectedDates: string[]) {
    if (!supabase || !profile) return
    const dateSet = new Set(selectedDates)
    const targets = requests.filter((r) => dateSet.has(r.transport_date) && !!r.registry_file_path && (profile.role !== 'customer' || r.requester_id === profile.id))
    if (!targets.length) { setError('Во вложениях заявок выбранных дней нет реестров для объединения.'); return }
    setSaving(true); setError(''); setNotice('')
    try {
      const XLSX = await import('xlsx')
      const merged: Record<string, unknown>[] = []
      const allKeys = new Set<string>(['Система: Номер заявки','Система: Дата перевозки','Система: Заказчик','Система: Имя реестра','Система: Лист'])
      for (const request of targets) {
        const { data: file, error: fileError } = await supabase.storage.from('dispatch-files').download(request.registry_file_path!)
        if (fileError || !file) throw new Error(`Не удалось скачать ${request.registry_file_name || `реестр заявки №${request.request_no}`}: ${fileError?.message || 'файл недоступен'}`)
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false })
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName]
          const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
          if (!values.length) continue
          const rawHeaders = values[0].map((v, i) => String(v || `Колонка ${i + 1}`).trim())
          const headers = rawHeaders.map((header, i) => rawHeaders.indexOf(header) === i ? header : `${header}_${i + 1}`)
          headers.forEach((h) => allKeys.add(h))
          values.slice(1).forEach((row) => {
            if (!row.some((v) => String(v ?? '').trim())) return
            const record: Record<string, unknown> = { 'Система: Номер заявки': request.request_no, 'Система: Дата перевозки': request.transport_date, 'Система: Заказчик': request.profiles?.username || '', 'Система: Имя реестра': request.registry_file_name || '', 'Система: Лист': sheetName }
            headers.forEach((header, i) => { record[header] = row[i] ?? '' })
            merged.push(record)
          })
        }
      }
      if (!merged.length) throw new Error('В выбранных реестрах нет строк с данными.')
      const headers = Array.from(allKeys)
      const workbook = XLSX.utils.book_new()
      const sheet = XLSX.utils.json_to_sheet(merged, { header: headers })
      sheet['!cols'] = headers.map((h) => ({ wch: Math.min(40, Math.max(14, h.length + 2)) }))
      XLSX.utils.book_append_sheet(workbook, sheet, 'Общий реестр')
      XLSX.writeFile(workbook, `akson-consolidated-registries-${iso(today)}.xlsx`)
      setNotice(`Объединено ${targets.length} реестр(ов) в одну таблицу.`)
    } catch (e) { setError(`Не удалось объединить реестры: ${errorText(e)}`) }
    finally { setSaving(false) }
  }

  async function uploadRequestRegistry(request: TransportRequest, file: File) {
    if (!supabase || !profile) throw new Error('Нет подключения к Supabase.')
    const ownCustomer = profile.role === 'customer' && request.requester_id === profile.id
    const staff = profile.role === 'dispatcher' || profile.role === 'admin'
    if (!staff && !(ownCustomer && !['completed', 'cancelled'].includes(request.status))) {
      throw new Error('Загрузка реестра для этой заявки недоступна вашей роли или статусу.')
    }
    const extension = file.name.split('.').pop()?.toLowerCase() || ''
    if (!['xlsx', 'xls', 'csv', 'ods'].includes(extension)) throw new Error('Реестр должен быть в формате XLSX, XLS, CSV или ODS.')
    if (file.size > 20 * 1024 * 1024) throw new Error('Размер реестра не должен превышать 20 МБ.')
    const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || `registry.${extension}`
    const storagePath = `requests/${request.id}/${crypto.randomUUID()}-${safeName}`
    const { error: uploadError } = await supabase.storage.from('dispatch-files').upload(storagePath, file, { upsert: false, contentType: file.type || 'application/octet-stream' })
    if (uploadError) throw uploadError
    const { data: attachedRow, error: attachError } = await supabase.from('transport_requests')
      .update({ registry_file_path: storagePath, registry_file_name: file.name })
      .eq('id', request.id).select('id').maybeSingle()
    if (attachError || !attachedRow) {
      await supabase.storage.from('dispatch-files').remove([storagePath])
      throw new Error(attachError
        ? `Не удалось привязать файл к заявке: ${attachError.message}`
        : 'Файл загружен в хранилище, но запись заявки не обновлена. Проверьте права UPDATE для вашей роли.')
    }
    if (request.registry_file_path) {
      const { error: removeError } = await supabase.storage.from('dispatch-files').remove([request.registry_file_path])
      if (removeError) console.warn('Не удалось удалить заменённый реестр:', removeError.message)
    }
    setNotice(`Реестр заявки №${request.request_no} загружен.`)
    await loadData()
    if (staff) await loadHistory()
    return { path: storagePath, name: file.name }
  }

  async function uploadRegistryTemplate(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !supabase || profile?.role !== 'admin') return
    const extension = file.name.split('.').pop()?.toLowerCase() || ''
    if (!['xlsx', 'xls', 'csv', 'ods'].includes(extension)) { setError('Шаблон должен быть в формате XLSX, XLS, CSV или ODS.'); return }
    if (file.size > 20 * 1024 * 1024) { setError('Размер шаблона не должен превышать 20 МБ.'); return }
    const path = `templates/registry-template.${extension}`
    const previousPath = registryTemplatePath
    setTemplateUploading(true); setError('')
    const { error: uploadError } = await supabase.storage.from('dispatch-files').upload(path, file, { upsert: true, contentType: file.type || 'application/octet-stream' })
    if (uploadError) { setTemplateUploading(false); setError(`Не удалось загрузить шаблон: ${uploadError.message}`); return }
    const { error: updateError } = await supabase.from('portal_settings').update({ registry_template_path: path, registry_template_name: file.name, updated_at: new Date().toISOString() }).eq('id', true)
    setTemplateUploading(false)
    if (updateError) { setError(`Файл загружен, но не удалось сохранить его в настройках: ${updateError.message}`); return }
    if (previousPath && previousPath !== path) {
      const { error: removeError } = await supabase.storage.from('dispatch-files').remove([previousPath])
      if (removeError) console.warn('Не удалось удалить предыдущий шаблон реестра:', removeError.message)
    }
    setNotice(`Шаблон реестра «${file.name}» загружен.`)
    await loadSettings(); await loadHistory()
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
    const staff = profile.role === 'dispatcher' || profile.role === 'admin'
    const mayCreate = profile.role === 'customer' || staff
    const mayEdit = staff || (profile.role === 'customer' && !!existing && existing.requester_id === profile.id && existing.status === 'created')
    if (existing ? !mayEdit : !mayCreate) { setError('У вашей роли нет прав на это действие.'); return }
    if (staff && payload.transport_date < iso(today)) { setError('Сотрудники могут создавать и переносить заявки только на текущую или будущую дату.'); return }
    setSaving(true); setError('')
    try {
      const maySelectRequester = profile.role === 'admin' || (profile.role === 'dispatcher' && !existing)
      const requesterId = maySelectRequester ? (payload.requester_id || existing?.requester_id || '') : (existing?.requester_id || profile.id)
      const requesterProfile = requesterId === profile.id ? profile : people.find((person) => person.id === requesterId)
      if (!requesterId || !requesterProfile || requesterProfile.role !== 'customer' || !requesterProfile.is_active) throw new Error('Выберите действующего заказчика из списка пользователей.')
      const businessUnitId = existing && existing.requester_id === requesterId
        ? existing.business_unit_id
        : (requesterProfile.business_unit_id || null)
      const base = {
        requester_id: requesterId, business_unit_id: businessUnitId,
        transport_date: payload.transport_date, slot_number: payload.slot_number, slot_type: payload.slot_type,
        from_unit_id: payload.from_unit_id, from_other_address: payload.from_other_address,
        to_unit_id: payload.to_unit_id, to_other_address: payload.to_other_address,
        capacity_tons: payload.capacity_tons, loading_type: payload.loading_type,
        transport_task_number: payload.transport_task_number.trim() || null,
        request_comment: payload.request_comment.trim() || null
      }
      let id = existing?.id
      if (existing) {
        const { data: updatedRow, error: updateError } = await supabase.from('transport_requests')
          .update(base).eq('id', existing.id).select('id').maybeSingle()
        if (updateError) throw updateError
        if (!updatedRow) throw new Error('Заявка не обновлена: база данных не вернула изменённую запись. Проверьте права вашей роли.')
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
        kdk_pallets: payload.kdk_pallets, packaging_qty: payload.packaging_qty,
        equipment_pallet_places: cargoType === 'equipment' ? payload.equipment_pallet_places : 0
      }))
      if (cargoRows.length) {
        const { error: cargoError } = await supabase.from('request_cargo').insert(cargoRows.map((row) => ({ ...row, request_id: id })))
        if (cargoError) throw cargoError
      }

      let registryWarning = ''
      if (payload.registry_file) {
        const file = payload.registry_file
        const extension = file.name.split('.').pop()?.toLowerCase() || ''
        if (!['xlsx', 'xls', 'csv', 'ods'].includes(extension)) registryWarning = 'Формат реестра должен быть XLSX, XLS, CSV или ODS.'
        else if (file.size > 20 * 1024 * 1024) registryWarning = 'Размер реестра не должен превышать 20 МБ.'
        else {
          const safeName = file.name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || `registry.${extension}`
          const storagePath = `requests/${id}/${crypto.randomUUID()}-${safeName}`
          const { error: uploadError } = await supabase.storage.from('dispatch-files').upload(storagePath, file, { upsert: false, contentType: file.type || 'application/octet-stream' })
          if (uploadError) registryWarning = `Не удалось прикрепить реестр: ${uploadError.message}`
          else {
            const { data: attachedRow, error: attachError } = await supabase.from('transport_requests')
              .update({ registry_file_path: storagePath, registry_file_name: file.name })
              .eq('id', id).select('id').maybeSingle()
            if (attachError || !attachedRow) {
              await supabase.storage.from('dispatch-files').remove([storagePath])
              registryWarning = `Заявка сохранена, но реестр не прикреплён: ${attachError?.message || 'база данных не обновила запись заявки. Проверьте права UPDATE для вашей роли.'}`
            } else if (existing?.registry_file_path) {
              const { error: removeOldError } = await supabase.storage.from('dispatch-files').remove([existing.registry_file_path])
              if (removeOldError) console.warn('Не удалось удалить заменённый реестр из Storage:', removeOldError.message)
            }
          }
        }
      }

      const savedDate = new Date(`${payload.transport_date}T00:00:00`)
      const savedMonth = new Date(savedDate.getFullYear(), savedDate.getMonth(), 1)
      const calendarLastDay = new Date(today); calendarLastDay.setDate(calendarLastDay.getDate() + 29)
      const savedDateIsVisible = payload.transport_date >= iso(today) && payload.transport_date <= iso(calendarLastDay)
      setRequestModal({ open: false }); setMonth(savedMonth); setSelectedDay(savedDateIsVisible ? payload.transport_date : iso(today)); setView('calendar')
      setNotice(existing ? 'Заявка обновлена.' : 'Заявка создана.')
      await loadData(savedMonth)
      if (registryWarning) setError(`${registryWarning} Заявка сохранена; реестр можно добавить позднее, открыв её на редактирование.`)
      if (staff) await loadHistory()
    } catch (e) { setError(errorText(e)) }
    finally { setSaving(false) }
  }

  async function changeStatus(request: TransportRequest, status: RequestStatus) {
    if (!supabase || !profile) return
    const canStaffChange = profile.role === 'dispatcher' || profile.role === 'admin'
    const canCustomerCancel = profile.role === 'customer' && request.requester_id === profile.id && request.status === 'created' && status === 'cancelled'
    if (!canStaffChange && !canCustomerCancel) { setError('У вашей роли нет прав на изменение статуса этой заявки.'); return }
    setError('')
    const { data: updated, error: updateError } = await supabase.from('transport_requests').update({ status }).eq('id', request.id).select('id,status').maybeSingle()
    if (updateError) setError(updateError.message)
    else if (!updated) setError('Статус не изменён: база данных не разрешила обновление этой заявки.')
    else { setNotice(`Статус заявки №${request.request_no} изменён и сохранён в Supabase.`); await loadData(); if (profile.role === 'dispatcher' || profile.role === 'admin') await loadHistory() }
  }

  async function cancelRequest(request: TransportRequest) {
    if (!profile) return
    const permitted = profile.role === 'dispatcher' || profile.role === 'admin'
      || (profile.role === 'customer' && request.requester_id === profile.id && request.status === 'created')
    if (!permitted) { setError('У вашей роли нет прав на отмену этой заявки.'); return }
    if (!supabase || !window.confirm(`Отменить заявку №${request.request_no}?`)) return
    await changeStatus(request, 'cancelled')
  }

  async function createUser(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
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
    setShowUserForm(false); await loadPeople(); await loadHistory()
  }

  function openUserEditor(person: Profile) {
    setEditingPerson(person)
    setUserEditDraft({ username: person.username, password: '', role: person.role, business_unit_id: person.business_unit_id || '', default_from_id: person.default_from_id || '', is_active: person.is_active })
  }

  async function saveUserEdit(event: FormEvent) {
    event.preventDefault()
    if (!supabase || !editingPerson) return
    setSaving(true); setError('')
    const { data, error: invokeError } = await supabase.functions.invoke('admin-update-user', {
      body: {
        user_id: editingPerson.id,
        username: userEditDraft.username.trim(),
        password: userEditDraft.password || undefined,
        role: userEditDraft.role,
        business_unit_id: userEditDraft.business_unit_id || null,
        default_from_id: userEditDraft.default_from_id || null,
        is_active: userEditDraft.is_active
      }
    })
    setSaving(false)
    if (invokeError) { setError(`Не удалось изменить пользователя. Проверьте развёртывание Edge Function admin-update-user. ${invokeError.message}`); return }
    if (data?.error) { setError(String(data.error)); return }
    setNotice(`Профиль пользователя ${userEditDraft.username.trim()} обновлён.`)
    if (editingPerson.id === profile?.id) {
      setProfile((current) => current ? { ...current, username: userEditDraft.username.trim(), role: userEditDraft.role, business_unit_id: userEditDraft.business_unit_id || null, default_from_id: userEditDraft.default_from_id || null, is_active: userEditDraft.is_active } : current)
    }
    setEditingPerson(null); await loadPeople(); await loadHistory()
  }

  async function toggleUser(profileRow: Profile) {
    if (!supabase || profileRow.id === profile?.id) return
    const { error: updateError } = await supabase.from('profiles').update({ is_active: !profileRow.is_active }).eq('id', profileRow.id)
    if (updateError) setError(`Не удалось изменить доступ. ${updateError.message}`)
    else { setNotice(profileRow.is_active ? 'Доступ пользователя приостановлен.' : 'Доступ пользователя восстановлен.'); await loadPeople(); await loadHistory() }
  }

  async function saveUnit(event: FormEvent) {
    event.preventDefault()
    if (!supabase) return
    setSaving(true); setError('')
    const payload = {
      code: unitDraft.code.trim(), name: unitDraft.name.trim(), kind: unitDraft.kind,
      address: unitDraft.address.trim() || null
    }
    const result = unitDraft.id
      ? await supabase.from('business_units').update(payload).eq('id', unitDraft.id)
      : await supabase.from('business_units').insert({ ...payload, is_active: true })
    setSaving(false)
    if (result.error) setError(result.error.message)
    else {
      setNotice(unitDraft.id ? 'Запись справочника обновлена.' : 'Элемент справочника добавлен.')
      setUnitDraft({ id: null, code: '', name: '', kind: 'BE', address: '' }); setUnitFormOpen(false)
      await loadData(); await loadHistory()
    }
  }

  function openUnitEditor(unit: BusinessUnit) {
    setUnitDraft({ id: unit.id, code: unit.code, name: unit.name, kind: unit.kind, address: unit.address || '' })
    setUnitFormOpen(true)
  }

  async function toggleUnit(unit: BusinessUnit) {
    if (!supabase) return
    const { error: unitError } = await supabase.from('business_units').update({ is_active: !unit.is_active }).eq('id', unit.id)
    if (unitError) setError(unitError.message)
    else { setNotice(unit.is_active ? 'Элемент справочника деактивирован.' : 'Элемент справочника активирован.'); await loadData(); await loadHistory() }
  }

  const calendarDays = useMemo(() => {
    // DockSlot-style full-week grid. The active booking window remains 30 days
    // from today; preceding weekdays and the trailing days that complete the
    // final week are rendered but visually muted in CalendarView.
    const firstRequested = new Date(today)
    if (showPrevious30Days) firstRequested.setDate(firstRequested.getDate() - 30)
    const firstOffset = (firstRequested.getDay() + 6) % 7
    const firstVisible = new Date(firstRequested)
    firstVisible.setDate(firstVisible.getDate() - firstOffset)

    const lastRequested = new Date(today)
    lastRequested.setDate(lastRequested.getDate() + 29)
    const lastOffset = (lastRequested.getDay() + 6) % 7
    const daysAfterLast = 6 - lastOffset
    const totalDays = firstOffset + (showPrevious30Days ? 60 : 30) + daysAfterLast

    return Array.from({ length: totalDays }, (_, index) => {
      const day = new Date(firstVisible)
      day.setDate(firstVisible.getDate() + index)
      return day
    })
  }, [showPrevious30Days])

  const visibleRequests = useMemo(() => {
    const scoped = requests.filter((request) => profile?.role !== 'customer' || request.requester_id === profile.id)
    return scoped.filter((request) => {
      const matchesStatus = statusFilter === 'all' || (statusFilter === 'active' ? !['cancelled', 'completed'].includes(request.status) : request.status === statusFilter)
      const requester = request.profiles?.username?.toLowerCase() || ''
      const fromUnit = units.find((u) => u.id === request.from_unit_id)
      const toUnit = units.find((u) => u.id === request.to_unit_id)
      const fromName = `${fromUnit?.kind === 'BE' ? 'БЕ' : ''} ${resolveUnit(units, request.from_unit_id, request.from_other_address)} ${request.from_unit_id ? fromUnit?.address || '' : request.from_other_address || ''}`.toLowerCase()
      const toName = `${toUnit ? (toUnit.kind === 'RC' ? 'РЦ' : 'БЕ') : ''} ${resolveUnit(units, request.to_unit_id, request.to_other_address)} ${request.to_unit_id ? toUnit?.address || '' : request.to_other_address || ''}`.toLowerCase()
      const matchesCancelled = showCancelled || statusFilter === 'cancelled' || request.status !== 'cancelled'
      return matchesStatus && matchesCancelled && matchesAllTerms(requester, requesterFilter) && matchesAllTerms(fromName, fromFilter) && matchesAllTerms(toName, toFilter)
    }).sort((a, b) => b.request_no - a.request_no)
  }, [requests, profile, statusFilter, requesterFilter, fromFilter, toFilter, showCancelled, units])

  const activeRequests = requests.filter((r) => r.status !== 'cancelled')
  const countStatus = (status: RequestStatus) => requests.filter((r) => r.status === status).length
  const ownRequests = requests.filter((r) => profile?.role !== 'customer' || r.requester_id === profile?.id)
  const selectedRequests = ownRequests.filter((r) => r.transport_date === selectedDay)
  const isAdmin = profile?.role === 'admin'
  const pageTitles: Record<View, string> = { overview: 'Обзор', calendar: 'Календарь', requests: 'Заявки на транспорт', reports: 'Отчёты', users: 'Пользователи', directory: 'Справочник БЕ и РЦ', settings: 'Настройки', history: 'История изменений', instructions: 'Инструкция' }

  if (!supabaseConfigured) return <SetupScreen />
  if (!session || !profile) return <LoginScreen login={login} password={password} setLogin={setLogin} setPassword={setPassword} signIn={signIn} busy={loginBusy} error={error} />

  const canViewStaffPages = profile.role === 'dispatcher' || profile.role === 'admin'
  const canCreateRequest = profile.role === 'customer' || profile.role === 'dispatcher' || profile.role === 'admin'
  const navItems: { key: View; label: string; icon: typeof LayoutDashboard; admin?: boolean; staff?: boolean }[] = [
    { key: 'overview', label: 'Обзор', icon: LayoutDashboard },
    { key: 'calendar', label: 'Календарь', icon: CalendarDays },
    { key: 'requests', label: 'Заявки', icon: FileSpreadsheet },
    { key: 'reports', label: 'Отчёты', icon: Activity, staff: true },
    { key: 'users', label: 'Пользователи', icon: Users, admin: true },
    { key: 'directory', label: 'Справочник', icon: Building2, admin: true },
    { key: 'settings', label: 'Настройки', icon: SlidersHorizontal, admin: true },
    { key: 'history', label: 'История', icon: HistoryIcon, staff: true },
    { key: 'instructions', label: 'Инструкция', icon: BookOpen }
  ]

  return <div className="app-shell">
    <div className="top-gradient-bar" />
    <header className="app-topbar">
      <button className="mobile-menu icon-button" aria-label="Открыть меню" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={19} /></button>
      <div className="brand-area"><img src={theme === 'dark' ? '/assets/logistic-logo-dark.svg' : '/assets/logistic-logo.svg'} alt="Аксон Логистика" /><span className="brand-divider" /><div className="brand-product"><strong>Аксон Диспетчерская</strong><small>портал заказа транспорта</small></div></div>
      <div className="topbar-right"><div className="today-chip"><CalendarDays size={15} /><span>{today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</span></div><button className="icon-button" title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</button><div className="notification-anchor"><button className="icon-button notification-bell" title="Уведомления" aria-label="Уведомления" onClick={() => setNotificationPanelOpen((open) => !open)}><Bell size={18} />{notifications.some((item) => !item.read_at) && <span className="notification-count">{notifications.filter((item) => !item.read_at).length > 99 ? '99+' : notifications.filter((item) => !item.read_at).length}</span>}</button>{notificationPanelOpen && <div className="notification-panel"><div className="notification-panel-head"><strong>Уведомления</strong><div className="notification-panel-actions"><button type="button" className="notification-mark-all" onClick={markAllNotificationsRead} disabled={!notifications.some((item) => !item.read_at)}><Check size={13} />Прочитать все</button><button type="button" className="notification-panel-close" aria-label="Закрыть окно уведомлений" title="Закрыть" onClick={() => setNotificationPanelOpen(false)}><X size={14}/></button></div></div><div className="notification-list">{notifications.length ? notifications.slice(0, 15).map((item) => <button type="button" key={item.id} className={`notification-item ${item.read_at ? '' : 'unread'}`} onClick={() => { void markNotificationRead(item); setNotificationPanelOpen(false); setView('requests') }}><span className="notification-item-dot"/><span className="notification-item-copy"><strong>{item.title}</strong><span>{item.body}</span><small>{new Date(item.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span></button>) : <div className="notification-empty">Пока нет уведомлений</div>}</div><div className="notification-panel-foot"><span>{pushEnabled ? 'Push включены на этом устройстве' : 'Push-уведомления отключены'}</span>{!pushEnabled && <button type="button" className="button button-primary notification-enable" onClick={() => void enableBrowserPush()} disabled={pushBusy}>{pushBusy ? 'Подключаем…' : 'Включить push'}</button>}</div></div>}</div><div className="profile-chip"><div className="avatar">{profile.username.slice(0, 1).toUpperCase()}</div><div><strong>{profile.username}</strong><small>{roleNames[profile.role]}</small></div><ChevronDown size={14} /></div><button className="icon-button logout-button" title="Выйти" onClick={signOut}><LogOut size={17} /></button></div>
    </header>
    <div className="workspace">
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="side-nav">
          {navItems.filter((item) => (profile.role !== 'utz' && profile.role !== 'customer' || item.key !== 'overview') && (!item.admin || isAdmin) && (!item.staff || canViewStaffPages)).map((item) => {
            const Icon = item.icon
            return <button key={item.key} className={`nav-link ${view === item.key ? 'active' : ''}`} onClick={() => { setView(item.key); setSidebarOpen(false); setError(''); setNotice('') }}><Icon size={18} /><span>{item.label}</span>{item.key === 'requests' && activeRequests.length > 0 && <em>{activeRequests.length}</em>}</button>
          })}
        </nav>
      </aside>
      <main className="main-area">
        <div className="page-topline"><div><h1>{pageTitles[view]}</h1><p>{getSubtitle(view, profile)}</p></div><div className="page-actions">{view === 'requests' && <MonthControls month={month} setMonth={setMonth} />}{view === 'requests' && <button className="button button-secondary" title="Очистить фильтры заявок" onClick={() => { setRequesterFilter(''); setFromFilter(''); setToFilter(''); setStatusFilter('all'); setShowCancelled(false) }}><RefreshCw size={15} /> Сбросить фильтры</button>}{(view === 'calendar' || view === 'requests') && canCreateRequest && <button className="button button-primary" title="Создать новую заявку на транспорт" onClick={() => setRequestModal({ open: true })}><Plus size={16} /> Новая заявка</button>}</div></div>
        {error && <div className="message message-error"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Закрыть"><X size={15} /></button></div>}
        {notice && <div className="message message-success"><CheckCircle2 size={17} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Закрыть"><X size={15} /></button></div>}
        {view === 'overview' && profile.role !== 'customer' && <OverviewView profile={profile} requests={ownRequests} occupancy={occupancy} units={units} onNavigate={setView} onRequest={() => setRequestModal({ open: true })} onOpenRequest={(request) => setRequestModal({ open: true, request })} onSelectFilter={(filter) => { setRequesterFilter(''); setFromFilter(''); setToFilter(''); setStatusFilter(filter); setShowCancelled(filter === 'all' || filter === 'cancelled'); setView('requests') }} />}
        {view === 'calendar' && <CalendarView days={calendarDays} requests={ownRequests} allRequests={requests} searchRequests={searchRequests} slots={calendarSlots} occupancy={occupancy} selectedDay={selectedDay} setSelectedDay={setSelectedDay} profile={profile} units={units} minCreateDate={iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + (profile.role === 'customer' ? (Number(bookingAdvanceDays) || 0) : 0)))} reserveSlotLimit={Number(reserveSlotLimit) || 0} showPrevious30Days={showPrevious30Days} setShowPrevious30Days={setShowPrevious30Days} onCreate={(slot, date) => setRequestModal({ open: true, slot, date })} onOpen={(request) => setRequestModal({ open: true, request })} onCancel={cancelRequest} onDownloadRegistry={(path, name) => downloadPrivateFile(path, name)} onExportCsv={exportSelectedRequestsCsv} onExportRegistries={exportSelectedRegistries} />}
        {view === 'requests' && <RequestsView requests={visibleRequests} units={units} profile={profile} requesterFilter={requesterFilter} setRequesterFilter={setRequesterFilter} fromFilter={fromFilter} setFromFilter={setFromFilter} toFilter={toFilter} setToFilter={setToFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} showCancelled={showCancelled} setShowCancelled={setShowCancelled} onStatus={changeStatus} onEdit={(request) => setRequestModal({ open: true, request })} onCancel={cancelRequest} onDownloadRegistry={(path, name) => downloadPrivateFile(path, name)} />}
        {view === 'users' && isAdmin && <UsersView people={people} units={units} currentUserId={profile.id} formOpen={showUserForm} setFormOpen={setShowUserForm} draft={userDraft} setDraft={setUserDraft} onSubmit={createUser} onToggle={toggleUser} onEdit={openUserEditor} saving={saving} />}
        {view === 'directory' && isAdmin && <DirectoryView units={units} formOpen={unitFormOpen} setFormOpen={setUnitFormOpen} draft={unitDraft} setDraft={setUnitDraft} onSubmit={saveUnit} onToggle={toggleUnit} onEdit={openUnitEditor} saving={saving} />}
        {view === 'settings' && isAdmin && <SettingsView bookingAdvanceDays={bookingAdvanceDays} setBookingAdvanceDays={setBookingAdvanceDays} reserveSlotLimit={reserveSlotLimit} setReserveSlotLimit={setReserveSlotLimit} roleLimits={roleLimits} setRoleLimits={setRoleLimits} onSubmit={saveSettings} saving={saving} templateName={registryTemplateName} templateUploading={templateUploading} onTemplateUpload={uploadRegistryTemplate} onDownloadTemplate={downloadRegistryTemplate} />}
        {view === 'reports' && canViewStaffPages && <ReportsView rows={reportRows} from={reportsFrom} setFrom={setReportsFrom} to={reportsTo} setTo={setReportsTo} loading={reportsLoading} onGenerate={loadReports} />}
        {view === 'instructions' && <InstructionsView role={profile.role} />}
        {view === 'history' && canViewStaffPages && <HistoryView rows={auditRows} people={people} hasMore={historyHasMore} loadingMore={historyLoadingMore} onLoadMore={() => loadHistory(true)} search={historySearch} setSearch={setHistorySearch} entity={historyEntity} setEntity={setHistoryEntity} from={historyFrom} setFrom={setHistoryFrom} to={historyTo} setTo={setHistoryTo} onRefresh={loadHistory} />}
        <footer className="app-footer"><span>АКСОН ЛОГИСТИКА</span><span>Портал заказа транспорта · {new Date().getFullYear()}</span></footer>
      </main>
    </div>
    {editingPerson && <UserEditModal person={editingPerson} units={units} draft={userEditDraft} setDraft={setUserEditDraft} onSubmit={saveUserEdit} onClose={() => setEditingPerson(null)} saving={saving} currentUserId={profile.id} />}
    {requestModal.open && <RequestModal units={units} people={people} profile={profile} occupancy={occupancy} bookingAdvanceDays={Number(bookingAdvanceDays) || 0} request={requestModal.request} slot={requestModal.slot} initialDate={requestModal.date} onClose={() => setRequestModal({ open: false })} onSave={saveRequest} onUploadRegistry={uploadRequestRegistry} saving={saving} registryTemplateName={registryTemplateName} registryTemplatePath={registryTemplatePath} reserveSlotLimit={Number(reserveSlotLimit) || 0} onDownloadTemplate={downloadRegistryTemplate} onDownloadRegistry={(path, name) => downloadPrivateFile(path, name)} />}
    {notificationToast && <div className="notification-toast" role="status"><div className="notification-toast-icon"><Bell size={17}/></div><div className="notification-toast-copy"><strong>{notificationToast.title}</strong><span>{notificationToast.body}</span></div><button type="button" aria-label="Закрыть уведомление" onClick={() => setNotificationToast(null)}><X size={15}/></button></div>}
    {loading && <div className="loading-pill"><span className="spinner" /> Обновляем данные…</div>}
  </div>
}

const instructionContent: Record<Role, { title: string; intro: string; sections: { heading: string; points: string[] }[] }> = {
  customer: {
    title: 'Инструкция заказчика',
    intro: 'Создание и контроль собственных транспортных заявок.',
    sections: [
      { heading: 'Создание заявки', points: ['Откройте «Календарь», выберите нужную дату и нажмите на ячейку дня. Если заявок ещё нет, используйте действие создания заявки.', 'Заполните обязательные поля «Откуда» и «Куда»: выберите подразделение из списка либо выберите «Другой адрес» и укажите адрес вручную.', 'Если выбрано подразделение, его адрес подставляется автоматически. Проверьте дату, тип и параметры груза, номер задания и комментарий.', 'При необходимости прикрепите реестр в формате XLSX, XLS, CSV или ODS (до 20 МБ), затем сохраните заявку.'] },
      { heading: 'Основные и резервные слоты', points: ['Направление в РЦ из справочника использует основной слот (синий индикатор).', 'Другой адрес использует резервный слот (зелёный индикатор).', 'Лимиты основных и резервных слотов независимы. Смотрите свободные места соответствующего типа в календаре.'] },
      { heading: 'Просмотр и редактирование', points: ['В календаре и на странице «Заявки» отображаются только ваши заявки.', 'Откройте заявку, чтобы посмотреть маршрут, адреса, дату, параметры груза, статус и вложения.', 'Собственную заявку можно редактировать в разрешённых статусах. Возможность изменения отдельных полей определяется статусом заявки.', 'Реестр можно загрузить или заменить, если это разрешено текущим статусом. Для скачивания используйте кнопку текущего реестра, а не кнопку шаблона.'] },
      { heading: 'Поиск и статусы', points: ['Используйте фильтры календаря и списка заявок для поиска по дате, отправителю, получателю и другим доступным параметрам.', 'Статусы показывают ход обработки: «Создана», «Поиск транспорта», «Подтверждена», «Выполнена» или «Отменена».', 'Отменённые заявки по умолчанию скрыты в общем списке. Если доступен переключатель отображения отменённых, включите его для просмотра.'] },
      { heading: 'Выгрузка и помощь', points: ['В календаре включите инструменты выгрузки, отметьте даты и используйте доступную выгрузку собственных заявок или реестров.', 'Если реестр не отображается или не скачивается, проверьте, что загрузка завершилась, и обратитесь к диспетчеру или администратору.'] }
    ]
  },
  dispatcher: {
    title: 'Инструкция диспетчера',
    intro: 'Операционная обработка заявок и контроль транспортного потока.',
    sections: [
      { heading: 'Обзор и ежедневная работа', points: ['На странице «Обзор» контролируйте статистику: всего заявок, создано, в работе, выполнено и отменено. Карточки показателей открывают соответствующие списки заявок.', 'В блоке «Ближайшие заявки» нажмите на запись, чтобы открыть её карточку.', 'Начинайте обработку с новых заявок, проверяйте маршрут, дату, параметры груза и вложенный реестр.'] },
      { heading: 'Календарь и слоты', points: ['Календарь показывает транспортную загрузку по датам. При выборе дня справа отображаются заявки этого дня.', 'Используйте фильтры «Заказчик», «Откуда», «Куда», тип груза и грузоподъёмность. При активном поиске справа показываются ближайшие найденные активные заявки в пределах трёх отчётных месяцев.', 'Основной слот применяется для назначения в РЦ из справочника (синий индикатор), резервный — для другого адреса (зелёный индикатор). Пулы независимы.'] },
      { heading: 'Работа с заявками', points: ['На странице «Заявки» новые записи располагаются выше старых. Используйте фильтры по заказчику, отправлению, назначению и статусу.', 'Диспетчер может создавать и редактировать заявки в пределах своих прав, в том числе оформлять заявку от имени заказчика.', 'Проверяйте обязательные адреса, дату, тип груза, грузовые параметры, номер задания, комментарии и реестр.', 'Изменяйте статус в соответствии с фактическим этапом перевозки. Отменённые заявки скрыты по умолчанию; включите пиктограмму отображения отменённых для их просмотра.'] },
      { heading: 'Реестры и выгрузки', points: ['В карточке заявки скачивайте именно текущий вложенный реестр. Шаблон реестра — отдельный файл, предназначенный для заполнения.', 'Для массовой выгрузки включите инструменты выгрузки в календаре, отметьте нужные даты и выберите объединённую выгрузку реестров или CSV со сведениями по заявкам.', 'Диспетчер имеет доступ к реестрам заявок в пределах своих полномочий.'] },
      { heading: 'История и отчёты', points: ['Используйте «Историю» для контроля действий пользователей и изменений. Применяйте фильтры по пользователю и периоду.', 'В «Отчётах» анализируйте заявки, направления, типы груза и скорость закрытия за выбранный период.'] }
    ]
  },
  utz: {
    title: 'Инструкция УТЗ',
    intro: 'Контроль транспортных заявок, загрузки и получение информации о перевозках.',
    sections: [
      { heading: 'Рабочие страницы', points: ['После входа откроется «Календарь». УТЗ также доступен список «Заявки».', 'УТЗ видит заявки всех заказчиков в пределах назначенных прав, но не имеет стандартных прав на редактирование заявок и изменение статусов.', 'Страница «Обзор» и административные разделы УТЗ не показываются.'] },
      { heading: 'Календарь и фильтры', points: ['Выберите дату, чтобы увидеть заявки этого дня справа от календаря.', 'Используйте фильтры по заказчику, отправлению, назначению, типу груза и грузоподъёмности.', 'При активном поиске календарные индикаторы пересчитываются по найденным заявкам, а справа показываются ближайшие найденные активные заявки в пределах трёх отчётных месяцев.', 'Основные слоты относятся к направлениям в РЦ (синий индикатор), резервные — к другим адресам (зелёный индикатор). Их лимиты не пересекаются.'] },
      { heading: 'Просмотр заявок', points: ['Откройте заявку из календаря или списка, чтобы проверить маршрут, адреса, дату, груз, статус и комментарии.', 'Список заявок отсортирован по номеру от большего к меньшему. Отменённые заявки по умолчанию скрыты; при наличии переключателя включите его для просмотра.', 'Проверяйте, что выбран правильный пункт назначения: он определяет тип слота.'] },
      { heading: 'Реестры и выгрузки', points: ['В карточке заявки скачивайте текущий вложенный реестр, а не шаблон реестра.', 'Для массового получения файлов включите инструменты выгрузки в календаре, выберите даты и запустите выгрузку вложенных реестров.', 'Для получения сведений по заявкам используйте CSV-выгрузку по выбранным датам.'] }
    ]
  },
  admin: {
    title: 'Полное руководство администратора',
    intro: 'Администратор видит инструкции всех ролей и управляет настройками и доступом к порталу.',
    sections: [
      { heading: 'Роль заказчика', points: ['Заказчик создаёт и контролирует только собственные заявки.', 'При создании заявки обязательны «Откуда» и «Куда»: подразделение из списка либо «Другой адрес» с ручным вводом.', 'Заказчик может просматривать и скачивать текущий реестр только своей заявки, а редактирование зависит от статуса и разрешённых полей.'] },
      { heading: 'Роль диспетчера', points: ['Диспетчер обрабатывает заявки всех заказчиков, создаёт и редактирует заявки в рамках прав, изменяет статусы и контролирует транспортный поток.', 'Доступны обзор, календарь, заявки, отчёты и история.', 'Диспетчер может скачивать текущие реестры и выполнять массовые выгрузки.'] },
      { heading: 'Роль УТЗ', points: ['УТЗ просматривает календарь и заявки всех заказчиков, использует фильтры и выгрузки.', 'Стандартные права УТЗ не включают редактирование заявок или изменение статусов.', 'УТЗ может скачивать текущие реестры в пределах назначенного доступа.'] },
      { heading: 'Роль администратора', points: ['Администратор имеет полный доступ к обзору, календарю, заявкам, отчётам, истории, пользователям, справочникам и настройкам.', 'Администратор может создавать и редактировать заявки, изменять статусы, просматривать и скачивать реестры всех заявок.', 'В этом разделе администратору доступны все четыре инструкции. Обычные роли видят только собственную инструкцию.'] },
      { heading: 'Управление пользователями', points: ['В разделе «Пользователи» создавайте учётные записи, назначайте роли и редактируйте доступ.', 'Назначайте минимально необходимую роль в соответствии с обязанностями сотрудника.', 'При блокировке учётной записи пользователь теряет возможность входа в портал.'] },
      { heading: 'Справочник БЕ и РЦ', points: ['Поддерживайте актуальность справочника бизнес-единиц и распределительных центров.', 'Проверяйте наименование, код, тип подразделения и адрес: адрес из справочника автоматически подставляется в заявку.', 'Неактивные подразделения не должны использоваться для новых заявок; ранее созданные заявки должны сохранять исторические сведения.'] },
      { heading: 'Настройки и слоты', points: ['Настраивайте лимит заявок на пользователя в месяц в зависимости от роли.', 'Настройка предварительной записи задаёт минимальный срок: 0 — можно на текущую дату, 1 — начиная со следующего дня. Для сотрудников действуют отдельные правила создания с текущей даты.', 'Управляйте количеством резервных слотов. Основные и резервные пулы независимы; направление в РЦ использует основной пул, другой адрес — резервный.', 'Загрузите актуальный шаблон реестра. Он не заменяет реестры, приложенные к отдельным заявкам.'] },
      { heading: 'История, отчёты и контроль', points: ['Проверяйте историю изменений для разбора действий пользователей и спорных ситуаций.', 'Используйте отчёты для анализа заявок, направлений, типов груза и скорости закрытия.', 'Проверяйте массовые выгрузки и доступность текущих реестров при обращениях пользователей.'] }
    ]
  }
}

function InstructionsView({ role }: { role: Role }) {
  const roles: Role[] = role === 'admin' ? ['customer', 'dispatcher', 'utz', 'admin'] : [role]
  return <div className="instructions-page">
    {roles.map((item) => {
      const guide = instructionContent[item]
      return <section className="surface-card instruction-card" key={item}>
        <div className="instruction-card-heading"><div className="instruction-role-icon"><BookOpen size={19}/></div><div><h2>{guide.title}</h2><p>{guide.intro}</p></div></div>
        <div className="instruction-sections">
          {guide.sections.map((section) => <section className="instruction-section" key={section.heading}><h3>{section.heading}</h3><ul>{section.points.map((point, index) => <li key={index}>{point}</li>)}</ul></section>)}
        </div>
      </section>
    })}
    <section className="surface-card instruction-card push-instruction-card">
      <div className="instruction-card-heading"><div className="instruction-role-icon"><Bell size={19}/></div><div><h2>Как включить Push-уведомления</h2><p>Подключение системных уведомлений на компьютере или телефоне</p></div></div>
      <div className="instruction-sections">
        <section className="instruction-section"><h3>Подключение на устройстве</h3><ul>
          <li>Откройте Dispatch в обычном окне браузера и войдите под своей учётной записью.</li>
          <li>Нажмите на колокольчик в верхней панели и выберите «Включить push».</li>
          <li>Когда браузер запросит разрешение на уведомления, нажмите «Разрешить».</li>
          <li>Дождитесь подтверждения подключения. В окне уведомлений появится статус «Push включены на этом устройстве».</li>
          <li>Для проверки попросите администратора или диспетчера отправить вам тестовое штатное уведомление.</li>
        </ul></section>
        <section className="instruction-section"><h3>Подключение на других устройствах</h3><ul>
          <li>Подключение выполняется отдельно на каждом компьютере, телефоне и в каждом браузере.</li>
          <li>Например, Chrome на рабочем компьютере и Edge на ноутбуке — это две отдельные подписки.</li>
          <li>При смене браузера, очистке данных сайта или сбросе разрешений подключите Push повторно.</li>
          <li>Не используйте режим инкогнито для постоянной работы: браузер может не сохранить подписку.</li>
        </ul></section>
        <section className="instruction-section"><h3>Если уведомления не появляются</h3><ul>
          <li>Проверьте разрешение «Уведомления» для сайта Dispatch в настройках браузера.</li>
          <li>В Windows откройте «Параметры» → «Система» → «Уведомления» и разрешите уведомления для Chrome или Edge.</li>
          <li>Проверьте, что режим «Не беспокоить» или «Фокусировка» не блокирует баннеры.</li>
          <li>Если Push включён, но уведомление не пришло, обратитесь к администратору и сообщите время события.</li>
        </ul></section>
        <section className="instruction-section"><h3>Важная информация</h3><ul>
          <li>Разрешение браузера и подключение Push в Dispatch — обязательные шаги. Одного входа в систему недостаточно.</li>
          <li>Уведомления отправляются только пользователям, которым адресовано конкретное событие.</li>
          <li>Подписка привязана к пользователю и конкретному браузеру на конкретном устройстве.</li>
          <li>Не передавайте никому пароли, ключи или секреты Supabase. Для подключения Push они не нужны.</li>
        </ul></section>
      </div>
    </section>
  </div>
}

function SetupScreen() {
  return <div className="setup-screen"><div className="setup-card"><img src="/assets/logistic-logo.svg" alt="Аксон Логистика"/><div className="setup-mark"><Settings2 size={22}/></div><h1>Требуется настройка подключения</h1><p>В окружении проекта не найдены параметры Supabase. Добавьте в Vercel переменные <code>VITE_SUPABASE_URL</code> и <code>VITE_SUPABASE_ANON_KEY</code>, затем выполните новое развёртывание.</p></div></div>
}

function LoginScreen({ login, password, setLogin, setPassword, signIn, busy, error }: { login: string; password: string; setLogin: (v: string) => void; setPassword: (v: string) => void; signIn: (e: FormEvent) => void; busy: boolean; error: string }) {
  const [showPassword, setShowPassword] = useState(false)
  return <div className="login-screen"><div className="login-gradient"/><section className="login-panel"><div className="login-brand"><img src="/assets/logistic-logo.svg" alt="Аксон Логистика"/><span>ЛОГИСТИКА · ТРАНСПОРТ</span></div><div className="login-intro"><div className="login-icon"><Truck size={22}/></div><h1>Вход в портал</h1><p>Заказ транспорта между бизнес-единицами и распределительными центрами</p></div><form onSubmit={signIn} className="login-form"><label>Логин<input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="Например, IVANOV01" autoComplete="username" title="Логин учётной записи для входа в портал." required /></label><label>Пароль<div className="password-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Введите пароль" autoComplete="current-password" title="Пароль вашей учётной записи." required/><button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}><Eye size={17}/></button></div></label>{error && <div className="login-error"><AlertCircle size={16}/>{error}</div>}<button className="button button-primary login-submit" disabled={busy} title="Проверить логин и пароль и войти в портал">{busy ? 'Выполняется вход…' : 'Войти в систему'}<ArrowRight size={17}/></button></form><div className="login-bottom"><ShieldCheck size={15}/> Защищённый доступ для сотрудников Аксон</div></section><div className="login-side"><div className="side-illustration"><div className="illustration-orbit orbit-one"/><div className="illustration-orbit orbit-two"/><div className="illustration-truck"><Truck size={104} strokeWidth={1.05}/></div><div className="route-node node-a"/><div className="route-node node-b"/><div className="route-line"/></div><div className="login-side-copy"><span>АКСОН ЛОГИСТИКА</span><h2>Транспортная логистика<br/>в едином пространстве</h2><p>Заявки, слоты, маршруты и координация перевозок — без лишних операций.</p></div></div></div>
}

function getSubtitle(view: View, profile: Profile) {
  if (view === 'overview') return `Здравствуйте, ${profile.username}. Сводная информация по транспортным заявкам.`
  if (view === 'calendar') return 'Планирование основных и резервных транспортных слотов на ближайшие 30 дней.'
  if (view === 'reports') return 'Заявки, направления, типы груза и скорость закрытия за выбранный период.'
  if (view === 'requests') return 'Поиск, контроль статусов и работа с заявками за выбранный месяц.'
  if (view === 'users') return 'Создание учётных записей, редактирование ролей и управление доступом.'
  if (view === 'directory') return 'Добавление и редактирование бизнес-единиц и распределительных центров.'
  if (view === 'settings') return 'Настройка лимитов заявок и минимального срока предварительной записи.'
  if (view === 'history') return 'Журнал действий пользователей и изменений в системе.'
  if (view === 'instructions') return profile.role === 'admin' ? 'Руководство по работе для всех ролей системы.' : `Руководство по работе для роли «${roleNames[profile.role]}».`
  return 'Справочник бизнес-единиц и распределительных центров.'
}

function OverviewView({ profile, requests, occupancy, units, onNavigate, onRequest, onOpenRequest, onSelectFilter }: {
  profile: Profile; requests: TransportRequest[]; occupancy: SlotOccupancy[]; units: BusinessUnit[];
  onNavigate: (view: View) => void; onRequest: () => void;
  onOpenRequest: (request: TransportRequest) => void; onSelectFilter: (filter: RequestListFilter) => void
}) {
  const periodRequests = requests.filter((r) => r.transport_date >= iso(new Date(today.getFullYear(), today.getMonth(), 1)) && r.transport_date <= iso(new Date(today.getFullYear(), today.getMonth() + 1, 0)))
  const active = periodRequests.filter((r) => !['cancelled', 'completed'].includes(r.status)).length
  const todayRequests = requests.filter((r) => r.transport_date === iso(today))
  const todayOccupancy = occupancy.filter((slot) => slot.transport_date === iso(today) && slot.slot_type === 'main')
  const stats: { label: string; value: number; icon: typeof FileSpreadsheet; tone: string; hint: string; filter: RequestListFilter }[] = [
    { label: 'Всего заявок', value: periodRequests.length, icon: FileSpreadsheet, tone: 'blue', hint: 'За текущий месяц · открыть все', filter: 'all' },
    { label: 'В работе', value: active, icon: Activity, tone: 'orange', hint: 'Созданные, в поиске и подтверждённые', filter: 'active' },
    { label: 'Подтверждено', value: periodRequests.filter((r) => r.status === 'confirmed').length, icon: CheckCircle2, tone: 'green', hint: 'Транспорт назначен', filter: 'confirmed' },
    { label: 'Выполнено', value: periodRequests.filter((r) => r.status === 'completed').length, icon: Truck, tone: 'violet', hint: 'Завершённые перевозки', filter: 'completed' },
    { label: 'Отменено', value: periodRequests.filter((r) => r.status === 'cancelled').length, icon: Ban, tone: 'grey', hint: 'Отменённые заявки', filter: 'cancelled' }
  ]
  const next = requests.filter((r) => r.transport_date >= iso(today) && !['cancelled', 'completed'].includes(r.status)).sort((a, b) => a.transport_date.localeCompare(b.transport_date) || a.slot_type.localeCompare(b.slot_type) || a.slot_number - b.slot_number).slice(0, 5)
  return <div className="overview-page">
    <div className="section-heading overview-section-heading"><div><h2>Показатели за месяц</h2></div><button className="subtle-link" onClick={() => onSelectFilter('all')}>Все заявки <ArrowRight size={15}/></button></div>
    <div className="stats-grid">{stats.map((item) => { const Icon = item.icon; return <button type="button" className="stat-card stat-card-button" key={item.label} onClick={() => onSelectFilter(item.filter)} title={`Открыть заявки: ${item.label.toLowerCase()}`} aria-label={`Открыть заявки: ${item.label}, ${item.value}`}><div className={`stat-icon tone-${item.tone}`}><Icon size={19}/></div><div className="stat-label">{item.label}</div><div className="stat-value">{item.value}</div><div className="stat-hint">{item.hint}</div></button> })}</div>
    <div className="overview-grid"><section className="surface-card upcoming-card"><div className="card-heading"><div><h3>Ближайшие заявки</h3><p>Предстоящие перевозки</p></div><button className="icon-button" onClick={() => onNavigate('requests')} title="Открыть все заявки"><ArrowUpRight size={17}/></button></div>{next.length ? <div className="upcoming-list">{next.map((r) => <button type="button" className="upcoming-row upcoming-row-button" key={r.id} onClick={() => onOpenRequest(r)} title={`Открыть заявку №${r.request_no}`} aria-label={`Открыть заявку №${r.request_no}, ${dateLabel(r.transport_date)}, ${statusNames[r.status]}`}><div className="upcoming-date"><strong>{new Date(`${r.transport_date}T00:00:00`).getDate()}</strong><span>{new Date(`${r.transport_date}T00:00:00`).toLocaleDateString('ru-RU', { month: 'short' })}</span></div><div className="upcoming-route"><strong>{resolveUnit(units, r.from_unit_id, r.from_other_address)} <ArrowRight size={13}/> {resolveUnit(units, r.to_unit_id, r.to_other_address)}</strong><small>№{r.request_no} · {r.slot_type === 'main' ? 'Основной' : 'Резервный'} слот {r.slot_number} · {r.capacity_tons} т</small></div><StatusBadge status={r.status}/></button>)}</div> : <EmptyState icon={CalendarDays} title="Предстоящих заявок нет" text="Когда появятся новые перевозки, они отобразятся здесь."/>}</section><section className="surface-card today-card"><div className="card-heading"><div><h3>Сегодня</h3><p>{today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div><div className="today-count">{todayOccupancy.length} <span>из 3 основных</span></div></div><div className="today-slot-list">{[1, 2, 3].map((slot) => { const request = todayRequests.find((r) => r.slot_type === 'main' && r.slot_number === slot && r.status !== 'cancelled'); const occupied = todayOccupancy.some((s) => s.slot_number === slot); return <div className="today-slot" key={slot}><div className={`slot-indicator ${occupied ? 'filled' : ''}`}>{slot}</div><div><strong>Основной слот {slot}</strong><small>{request ? `Заявка №${request.request_no}` : occupied ? 'Занят другой заявкой' : 'Свободен'}</small></div><span className={occupied ? 'slot-state occupied' : 'slot-state free'}>{occupied ? 'Занят' : 'Свободен'}</span></div>})}</div><button className="wide-subtle-button" onClick={() => onNavigate('calendar')}>Перейти к календарю <ArrowRight size={15}/></button></section></div>
    <div className="overview-bottom"><div className="info-mini"><div className="mini-icon"><Building2 size={18}/></div><div><strong>{units.filter((u) => u.kind === 'BE').length} бизнес-единиц</strong><small>В активном справочнике</small></div></div><div className="info-mini"><div className="mini-icon purple"><Warehouse size={18}/></div><div><strong>{units.filter((u) => u.kind === 'RC').length} распределительных центров</strong><small>Доступно для маршрутов</small></div></div><div className="info-mini"><div className="mini-icon green"><ShieldCheck size={18}/></div><div><strong>{roleNames[profile.role]}</strong><small>Ваша роль в системе</small></div></div></div>
  </div>
}

function CalendarView({ days, requests, allRequests, searchRequests, slots, occupancy, selectedDay, setSelectedDay, profile, units, minCreateDate, reserveSlotLimit, showPrevious30Days, setShowPrevious30Days, onCreate, onOpen, onCancel, onDownloadRegistry, onExportCsv, onExportRegistries }: {
  days: Date[]; requests: TransportRequest[]; allRequests: TransportRequest[]; searchRequests: TransportRequest[]; slots: CalendarSlot[]; occupancy: SlotOccupancy[];
  selectedDay: string; setSelectedDay: (v: string) => void; profile: Profile; units: BusinessUnit[]; minCreateDate: string; reserveSlotLimit: number;
  showPrevious30Days: boolean; setShowPrevious30Days: (v: boolean) => void;
  onCreate: (slot: number, date: string) => void; onOpen: (request: TransportRequest) => void; onCancel: (request: TransportRequest) => void;
  onDownloadRegistry: (path: string | null | undefined, name?: string | null) => void;
  onExportCsv: (dates: string[]) => void; onExportRegistries: (dates: string[]) => void
}) {
  const [customerFilter, setCustomerFilter] = useState('')
  const [fromFilter, setFromFilter] = useState('')
  const [toFilter, setToFilter] = useState('')
  const [cargoFilter, setCargoFilter] = useState('all')
  const [capacityFilter, setCapacityFilter] = useState('all')
  const [selectedExportDates, setSelectedExportDates] = useState<string[]>([])
  const [showExportTools, setShowExportTools] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const canCreate = profile.role === 'customer' || profile.role === 'dispatcher' || profile.role === 'admin'
  const canOperate = profile.role === 'dispatcher' || profile.role === 'admin'
  const isCustomer = profile.role === 'customer'
  const filtersActive = !isCustomer && (!!customerFilter.trim() || !!fromFilter.trim() || !!toFilter.trim() || cargoFilter !== 'all' || capacityFilter !== 'all')

  function matchesRequest(request: TransportRequest) {
    const fromUnit = units.find((u) => u.id === request.from_unit_id)
    const toUnit = units.find((u) => u.id === request.to_unit_id)
    const fromText = `${fromUnit?.kind === 'BE' ? 'БЕ' : ''} ${fromUnit?.code || ''} ${fromUnit?.name || ''} ${fromUnit?.address || ''} ${request.from_other_address || ''}`.toLowerCase()
    const toText = `${toUnit ? (toUnit.kind === 'RC' ? 'РЦ' : 'БЕ') : ''} ${toUnit?.code || ''} ${toUnit?.name || ''} ${toUnit?.address || ''} ${request.to_other_address || ''}`.toLowerCase()
    const customerText = (request.profiles?.username || '').toLowerCase()
    return matchesAllTerms(customerText, customerFilter)
      && matchesAllTerms(fromText, fromFilter)
      && matchesAllTerms(toText, toFilter)
      && (cargoFilter === 'all' || (request.request_cargo || []).some((c) => c.cargo_type === cargoFilter))
      && (capacityFilter === 'all' || String(request.capacity_tons) === capacityFilter)
  }

  const filteredPool = searchRequests.filter((r) => r.status !== 'cancelled' && r.status !== 'completed' && matchesRequest(r))
    .sort((a, b) => a.transport_date.localeCompare(b.transport_date) || a.slot_type.localeCompare(b.slot_type) || a.slot_number - b.slot_number)
  // Use both the visible calendar records (which include the muted days at the
  // start of the week) and the longer staff search horizon. Deduplicate by ID.
  const filteredCalendarRequests = Array.from(new Map(
    [...allRequests, ...searchRequests]
      .filter((r) => r.status !== 'cancelled' && r.status !== 'completed' && matchesRequest(r))
      .map((r) => [r.id, r] as const)
  ).values())
  const matchedCount = filtersActive ? filteredPool.length : allRequests.filter((r) => r.transport_date === selectedDay && r.status !== 'cancelled').length
  const selectedDateRequests = filtersActive
    ? filteredPool.slice(0, 3)
    : (isCustomer ? requests : allRequests)
        .filter((r) => r.transport_date === selectedDay && r.status !== 'cancelled')
        .sort((a, b) => a.request_no > b.request_no ? -1 : 1)
  const lastBookableDate = new Date(today)
  lastBookableDate.setDate(lastBookableDate.getDate() + 29)
  const maxCreateDate = iso(lastBookableDate)
  const selectedDatesSet = new Set(selectedExportDates)
  const shortDate = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
  const dayCounts = (dateKey: string) => {
    const slotRows = slots.filter((r) => r.transport_date === dateKey)
    const occupancyRows = occupancy.filter((r) => r.transport_date === dateKey)
    // Customers see only their own request count/indicator. Slot availability
    // remains global so free main/reserve capacity reflects the real shared pools.
    const allDayRequestRows = allRequests.filter((r) => r.transport_date === dateKey && r.status !== 'cancelled')
    const customerDayRequestRows = requests.filter((r) => r.transport_date === dateKey && r.status !== 'cancelled')
    const matchingRows = filtersActive ? filteredCalendarRequests.filter((r) => r.transport_date === dateKey) : []
    const rowsForCapacity = filtersActive ? matchingRows : [...slotRows, ...occupancyRows, ...allDayRequestRows]
    const mainSet = new Set<number>()
    const reserveSet = new Set<number>()
    rowsForCapacity.forEach((row) => (row.slot_type === 'main' ? mainSet : reserveSet).add(row.slot_number))
    // The blue day stripe and red badge indicate actual requests, not merely
    // occupied capacity rows. Customers see only their own requests; staff see
    // all requests (or only matching requests while filters are active).
    const total = filtersActive
      ? matchingRows.length
      : isCustomer
        ? customerDayRequestRows.length
        : allDayRequestRows.length
    return { main: mainSet.size, reserve: reserveSet.size, total, freeMain: Math.max(0, 3 - mainSet.size), freeReserve: Math.max(0, reserveSlotLimit - reserveSet.size) }
  }
  const toggleExportDate = (date: string) => setSelectedExportDates((old) => old.includes(date) ? old.filter((d) => d !== date) : [...old, date])
  const renderDay = (day: Date, outside = false, compact = false, stackIndex = 0) => {
    const key = iso(day)
    const counts = dayCounts(key)
    const unavailable = isCustomer && key < minCreateDate
    const pastDay = key < iso(today)
    const outsideHorizon = key > maxCreateDate
    // Later rows must paint above the row before them (badge overhangs upward);
    // earlier columns must paint above cells to their right (badge overhangs right).
    const stackZ = Math.floor(stackIndex / 7) * 10 + (6 - (stackIndex % 7)) + 1
    return <article key={key} role="button" tabIndex={0} aria-label={`Открыть заявки за ${dateLabel(key)}`} onClick={() => setSelectedDay(key)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedDay(key) } }} style={{ zIndex: stackZ }} className={`calendar-day ${counts.total > 0 ? 'has-booking-count' : ''} ${pastDay ? 'past-day' : ''} ${outsideHorizon ? 'outside-horizon' : ''} ${compact ? 'calendar-day-compact' : ''} ${outside ? 'outside' : ''} ${selectedDay === key ? 'selected' : ''} ${key === iso(today) ? 'today' : ''} ${unavailable ? 'booking-unavailable' : ''}`}>
      <div className="calendar-day-top"><button type="button" className="calendar-date-button" onClick={(event) => { event.stopPropagation(); setSelectedDay(key) }} title={`Показать заявки за ${dateLabel(key)}`}><span className="calendar-date-full">{shortDate(day)}</span></button>{showExportTools && <label className="calendar-export-check" onClick={(event) => event.stopPropagation()} title={`Включить ${dateLabel(key)} в выгрузку`}><input type="checkbox" checked={selectedDatesSet.has(key)} onClick={(event) => event.stopPropagation()} onChange={() => toggleExportDate(key)}/><span/></label>}</div>
      {counts.total > 0 && <span className="calendar-count-badge" aria-label={`Заявок: ${counts.total}`} title={`Заявок: ${counts.total}`}>{counts.total > 99 ? '99+' : counts.total}</span>}
      <div className="calendar-capacities"><span className="capacity-main" title={`Основные слоты: свободно ${counts.freeMain} из 3`}><Warehouse size={12}/><b>{counts.freeMain}</b></span><span className="capacity-reserve" title={`Резервные слоты: свободно ${counts.freeReserve} из ${reserveSlotLimit}`}><MapPin size={12}/><b>{counts.freeReserve}</b></span></div>
    </article>
  }
  const customerOrDayRequests = selectedDateRequests
  const resultsTitle = filtersActive ? 'Ближайшие совпадения' : `Заявки за ${dateLabel(selectedDay, { day: 'numeric', month: 'long', year: 'numeric' })}`
  const selectedDayIsBeforeBookingWindow = isCustomer && selectedDay < minCreateDate
  const selectedDayIsPast = selectedDay < iso(today)
  const selectedDayIsBeyondWindow = selectedDay > maxCreateDate
  const customerEmptyDayMessage = selectedDayIsPast
    ? 'Приём заявок на эту дату уже закрыт.'
    : selectedDayIsBeforeBookingWindow
      ? 'Приём заявок на эту дату закрыт.'
      : selectedDayIsBeyondWindow
        ? `Эта дата пока вне периода планирования. Сейчас можно создавать заявки до ${dateLabel(maxCreateDate)}.`
        : (dayCounts(selectedDay).freeMain + dayCounts(selectedDay).freeReserve) > 0
          ? 'На выбранный день ваших заявок пока нет. Можно создать новую заявку.'
          : 'На выбранный день ваших заявок нет, свободных слотов также не осталось.'
  return <div className="calendar-page">
    <section className="surface-card calendar-card">
      <div className="calendar-toolbar"><div className="calendar-toolbar-copy"><strong>Календарь</strong><span>Следующие 30 дней от текущей даты</span></div><div className="calendar-toolbar-actions"><button type="button" className={`icon-button ${showPrevious30Days ? 'active' : ''}`} onClick={() => setShowPrevious30Days(!showPrevious30Days)} title={showPrevious30Days ? 'Скрыть предыдущие 30 дней' : 'Показать предыдущие 30 дней'}><CalendarClock size={17}/></button><button type="button" className={`icon-button calendar-export-toggle ${showExportTools ? 'active' : ''}`} onClick={() => setShowExportTools(!showExportTools)} aria-pressed={showExportTools} title={showExportTools ? 'Скрыть инструменты выгрузки' : 'Показать инструменты выгрузки'}><Download size={17}/></button></div></div>
      {showExportTools && <div className="calendar-export-toolbar"><span>Выбрано дней: <b>{selectedExportDates.length}</b></span><button className="button button-secondary button-compact" disabled={!selectedExportDates.length || exportBusy} onClick={async () => { setExportBusy(true); try { await onExportRegistries(selectedExportDates) } finally { setExportBusy(false) } }}><FileSpreadsheet size={14}/> Объединить реестры</button><button className="button button-secondary button-compact" disabled={!selectedExportDates.length || exportBusy} onClick={() => onExportCsv(selectedExportDates)}><Download size={14}/> Выгрузить список CSV</button><button className="icon-button small" onClick={() => setSelectedExportDates([])} title="Снять отметки со всех дат"><X size={14}/></button></div>}
      {!isCustomer && <div className="calendar-filters calendar-filters-split">
        <label><span>Заказчик</span><input value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} placeholder="Логин заказчика"/></label>
        <label><span>Откуда</span><input value={fromFilter} onChange={(e) => setFromFilter(e.target.value)} placeholder="БЕ или адрес отправления"/></label>
        <label><span>Куда</span><input value={toFilter} onChange={(e) => setToFilter(e.target.value)} placeholder="РЦ или адрес назначения"/></label>
        <label><span>Тип груза</span><select value={cargoFilter} onChange={(e) => setCargoFilter(e.target.value)} title="Фильтр по типу груза"><option value="all">Все типы груза</option><option value="goods">Товар</option><option value="equipment">Оборудование</option><option value="packaging">Тара</option></select></label>
        <label><span>Грузоподъёмность</span><select value={capacityFilter} onChange={(e) => setCapacityFilter(e.target.value)} title="Фильтр по грузоподъёмности"><option value="all">Любой тоннаж</option><option value="1.5">1,5 т</option><option value="5">5 т</option><option value="10">10 т</option><option value="20">20 т</option></select></label>
        {filtersActive && <button className="icon-button small" title="Сбросить фильтры календаря" onClick={() => { setCustomerFilter(''); setFromFilter(''); setToFilter(''); setCargoFilter('all'); setCapacityFilter('all') }}><X size={14}/></button>}
        <span className="calendar-filter-count">Найдено: <b>{matchedCount}</b></span>
      </div>}
      <div className="calendar-weekdays">{['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map((d) => <div key={d}>{d}</div>)}</div>
      <div className="calendar-grid">{days.map((day, index) => renderDay(day, false, false, index))}</div>
      <div className="calendar-foot"><span><span className="online-dot"/> Заявок за выбранный период: {(isCustomer ? requests : allRequests).filter((r) => r.status !== 'cancelled').length}</span><div className="calendar-foot-legend"><span><Warehouse size={13}/> Основные слоты — направление в РЦ</span><span><MapPin size={13}/> Резервные слоты — другие адреса</span></div></div>
    </section>
    <section className="surface-card selected-day-card">
      <div className="card-heading"><div><h3>{resultsTitle}</h3><p>{filtersActive ? 'Фильтр не привязан к выбранному дню · горизонт 3 месяца' : isCustomer ? 'Ваши заявки на выбранную дату' : 'Заявки всех пользователей на выбранную дату'}</p></div><div className="day-count">{customerOrDayRequests.length}<small>{filtersActive ? 'из найденных' : 'заявок'}</small></div></div>
      <div className="selected-slots selected-request-list">
        {customerOrDayRequests.length ? customerOrDayRequests.map((request) => {
          const own = request.requester_id === profile.id
          const canOpen = !isCustomer || own
          const originUnit = units.find((u) => u.id === request.from_unit_id)
          const destUnit = units.find((u) => u.id === request.to_unit_id)
          return <article className="selected-request-card" key={request.id}>{canOpen && <button type="button" className="icon-button small selected-request-view" onClick={() => onOpen(request)} title="Открыть заявку"><Eye size={14}/></button>}<div className="selected-request-top"><strong>Заявка №{request.request_no}</strong><StatusBadge status={request.status}/></div><button type="button" className="selected-request-route" disabled={!canOpen} onClick={() => canOpen && onOpen(request)}><span>{resolveUnit(units, request.from_unit_id, request.from_other_address)}</span><ArrowRight size={13}/><span>{resolveUnit(units, request.to_unit_id, request.to_other_address)}</span></button><div className="selected-request-addresses"><small>Адрес отправления: {request.from_unit_id ? originUnit?.address || 'Не указан в справочнике' : request.from_other_address || '—'}</small><small>Адрес назначения: {request.to_unit_id ? destUnit?.address || 'Не указан в справочнике' : request.to_other_address || '—'}</small></div><div className="selected-request-meta"><span className="selected-request-date">{dateLabel(request.transport_date, { day: 'numeric', month: 'short' })}</span><span>{request.slot_type === 'main' ? <Warehouse size={12}/> : <MapPin size={12}/>} {request.slot_type === 'main' ? 'Основной' : 'Резервный'} слот {request.slot_number}</span><span>{request.capacity_tons} т</span>{!isCustomer && <span>{request.profiles?.username || 'Заказчик'}</span>}</div>{((request.registry_file_path && (!isCustomer || own)) || (isCustomer && own && request.status === 'created')) && <div className="selected-request-actions">{request.registry_file_path && (!isCustomer || own) && <button className="icon-button small" onClick={() => onDownloadRegistry(request.registry_file_path, request.registry_file_name)} title="Скачать вложенный реестр"><Download size={14}/></button>}{isCustomer && own && request.status === 'created' && <button className="icon-button small danger-icon" onClick={() => onCancel(request)} title="Отменить заявку"><Ban size={14}/></button>}</div>}</article>
        }) : <div className="selected-day-empty"><CalendarDays size={24}/><strong>{filtersActive ? 'Совпадений не найдено' : isCustomer ? 'На выбранный день ваших заявок нет' : 'На выбранный день заявок нет'}</strong><span>{filtersActive ? 'Измените параметры фильтра.' : isCustomer ? customerEmptyDayMessage : (dayCounts(selectedDay).freeMain + dayCounts(selectedDay).freeReserve) > 0 ? 'Можно создать новую заявку на этот день.' : 'Свободных основных и резервных слотов на этот день нет.'}</span>{!filtersActive && canCreate && selectedDay >= minCreateDate && selectedDay <= maxCreateDate && (dayCounts(selectedDay).freeMain + dayCounts(selectedDay).freeReserve) > 0 && <button className="button button-primary button-compact" onClick={() => onCreate(1, selectedDay)}><Plus size={14}/> Создать заявку</button>}</div>}
      </div>
      {!filtersActive && selectedDateRequests.length > 0 && canCreate && selectedDay >= minCreateDate && selectedDay <= maxCreateDate && (dayCounts(selectedDay).freeMain + dayCounts(selectedDay).freeReserve) > 0 && <button className="button button-outline button-compact selected-day-create" onClick={() => onCreate(1, selectedDay)}><Plus size={14}/> Добавить заявку на этот день</button>}
      <div className="selected-day-tip"><CircleHelp size={15}/>{isCustomer ? `Отображаются только ваши заявки. Адреса выбранных БЕ и РЦ берутся из справочника. Создание доступно с ${dateLabel(minCreateDate)}.` : filtersActive ? 'Поиск по заказчику, отправлению и назначению охватывает ближайшие три отчётных месяца. Завершённые и отменённые заявки не показываются.' : 'Для каждого дня свободные основные и резервные слоты рассчитываются независимо.'}</div>
    </section>
  </div>
}

function RequestsView({ requests, units, profile, requesterFilter, setRequesterFilter, fromFilter, setFromFilter, toFilter, setToFilter, statusFilter, setStatusFilter, showCancelled, setShowCancelled, onStatus, onEdit, onCancel, onDownloadRegistry }: {
  requests: TransportRequest[]; units: BusinessUnit[]; profile: Profile; requesterFilter: string; setRequesterFilter: (v: string) => void;
  fromFilter: string; setFromFilter: (v: string) => void; toFilter: string; setToFilter: (v: string) => void;
  statusFilter: RequestListFilter; setStatusFilter: (v: RequestListFilter) => void; showCancelled: boolean; setShowCancelled: (v: boolean) => void;
  onStatus: (r: TransportRequest, s: RequestStatus) => void; onEdit: (r: TransportRequest) => void; onCancel: (r: TransportRequest) => void;
  onDownloadRegistry: (path: string | null | undefined, name?: string | null) => void
}) {
  const canChangeStatuses = profile.role === 'dispatcher' || profile.role === 'admin'
  const isCustomer = profile.role === 'customer'
  function exportCsv() {
    const headers = ['Номер заявки', 'Номер задания на перевозку', 'Комментарий', 'Дата', 'Тип слота', 'Слот', 'БЕ', 'Откуда', 'Адрес отправления', 'Куда', 'Адрес назначения', 'Заказчик', 'Грузоподъёмность, т', 'Погрузка', 'Груз', 'Реестр', 'Статус']
    const rows = requests.map((r) => {
      const fromUnit = units.find((u) => u.id === r.from_unit_id); const toUnit = units.find((u) => u.id === r.to_unit_id)
      return [r.request_no, r.transport_task_number || '', r.request_comment || '', r.transport_date, r.slot_type === 'main' ? 'Основной' : 'Резервный', r.slot_number, r.business_units?.code || '', resolveUnit(units, r.from_unit_id, r.from_other_address), r.from_unit_id ? fromUnit?.address || '' : r.from_other_address || '', resolveUnit(units, r.to_unit_id, r.to_other_address), r.to_unit_id ? toUnit?.address || '' : r.to_other_address || '', r.profiles?.username || '', r.capacity_tons, r.loading_type === 'rear' ? 'Задняя' : 'Боковая', (r.request_cargo || []).map((c) => cargoNames[c.cargo_type] || c.cargo_type).join('; '), r.registry_file_name || '', statusNames[r.status]]
    })
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = '\uFEFF' + [headers, ...rows].map((row) => row.map(escape).join(';')).join('\r\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a'); link.href = url; link.download = `akson-transport-requests-${iso(today)}.csv`; link.click(); URL.revokeObjectURL(url)
  }
  return <div className="requests-page">
    <section className="surface-card filters-card filters-card-split">
      <div className="requests-filter-tools"><span className="results-count">Найдено: <strong>{requests.length}</strong></span><button type="button" className={`icon-button cancelled-toggle ${showCancelled || statusFilter === 'cancelled' ? 'active' : ''}`} aria-pressed={showCancelled || statusFilter === 'cancelled'} onClick={() => { if (statusFilter === 'cancelled') { setStatusFilter('all'); setShowCancelled(false) } else setShowCancelled(!showCancelled) }} title={showCancelled || statusFilter === 'cancelled' ? 'Скрыть отменённые заявки' : 'Показать отменённые заявки'}><Ban size={16}/></button><button type="button" className="icon-button request-export-button" onClick={exportCsv} disabled={!requests.length} title="Выгрузить отображаемые заявки в CSV"><FileSpreadsheet size={16}/></button></div>
      <div className="requests-filter-fields">
        <label className="request-filter-field"><span>Заказчик</span><div className="search-field"><Search size={15}/><input value={requesterFilter} onChange={(e) => setRequesterFilter(e.target.value)} placeholder="Логин заказчика"/></div></label>
        <label className="request-filter-field"><span>Откуда</span><div className="search-field"><Search size={15}/><input value={fromFilter} onChange={(e) => setFromFilter(e.target.value)} placeholder="БЕ или адрес отправления"/></div></label>
        <label className="request-filter-field"><span>Куда</span><div className="search-field"><Search size={15}/><input value={toFilter} onChange={(e) => setToFilter(e.target.value)} placeholder="РЦ или адрес назначения"/></div></label>
        <div className="filter-select"><Filter size={16}/><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as RequestListFilter)} title="Отобрать заявки по статусу"><option value="all">Все статусы</option><option value="active">В работе</option>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      </div>
    </section>
    {requests.length ? <section className="surface-card table-card"><div className="table-scroll"><table className="requests-table"><thead><tr><th>Заявка</th><th>Дата / слот</th><th>Маршрут</th><th>Заказчик</th><th>Параметры</th><th>Статус</th><th>Действия</th></tr></thead><tbody>{requests.map((r) => {
      const fromUnit = units.find((u) => u.id === r.from_unit_id); const toUnit = units.find((u) => u.id === r.to_unit_id)
      return <tr key={r.id}><td><strong className="request-number">№{r.request_no}</strong><small>Транспорт</small></td><td><strong>{dateLabel(r.transport_date, { day: 'numeric', month: 'short' })}</strong><small>{r.slot_type === 'main' ? 'Основной' : 'Резервный'} слот {r.slot_number}</small></td><td><div className="table-route"><strong>{resolveUnit(units, r.from_unit_id, r.from_other_address)}</strong><ArrowRight size={13}/><strong>{resolveUnit(units, r.to_unit_id, r.to_other_address)}</strong></div><small>{r.business_units?.code || 'БЕ'}</small><small>Откуда: {r.from_unit_id ? fromUnit?.address || 'Адрес не указан' : r.from_other_address || '—'}</small><small>Куда: {r.to_unit_id ? toUnit?.address || 'Адрес не указан' : r.to_other_address || '—'}</small></td><td><strong>{r.profiles?.username || profile.username}</strong><small>{roleNames.customer}</small></td><td><strong>{r.capacity_tons} т</strong><small>{(r.request_cargo || []).map((c) => c.cargo_type === 'equipment' && c.equipment_pallet_places > 0 ? `${cargoNames[c.cargo_type]}: ${c.equipment_pallet_places} паллетомест` : cargoNames[c.cargo_type]).join(', ') || (r.loading_type === 'rear' ? 'Задняя' : 'Боковая')}{r.transport_task_number ? ` · Задание ${r.transport_task_number}` : ''}</small>{r.request_comment && <small title={r.request_comment}>{r.request_comment}</small>}</td><td>{canChangeStatuses ? <select className={`status-select ${statusClasses[r.status]}`} value={r.status} onChange={(e) => onStatus(r, e.target.value as RequestStatus)} title="Изменить статус заявки">{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select> : <StatusBadge status={r.status}/>}</td><td><div className="row-actions"><button className="icon-button small" onClick={() => onEdit(r)} title="Открыть заявку для просмотра и редактирования по правам роли"><Eye size={14}/></button>{r.registry_file_path && <button className="icon-button small" onClick={() => onDownloadRegistry(r.registry_file_path, r.registry_file_name)} title={`Скачать реестр: ${r.registry_file_name || 'вложение'}`}><Download size={14}/></button>}{(canChangeStatuses && r.status !== 'cancelled' || isCustomer && r.status === 'created') && <button className="icon-button small danger-icon" onClick={() => onCancel(r)} title="Отменить заявку"><Ban size={14}/></button>}</div></td></tr>
    })}</tbody></table></div></section> : <section className="surface-card empty-large"><EmptyState icon={Search} title="Заявки не найдены" text="Измените параметры фильтра или выберите другой статус."/></section>}
  </div>
}

function UsersView({ people, units, currentUserId, formOpen, setFormOpen, draft, setDraft, onSubmit, onToggle, onEdit, saving }: {
  people: Profile[]; units: BusinessUnit[]; currentUserId: string; formOpen: boolean; setFormOpen: (v: boolean) => void;
  draft: { username: string; password: string; role: Role; business_unit_id: string; default_from_id: string };
  setDraft: (v: any) => void; onSubmit: (e: FormEvent) => void; onToggle: (p: Profile) => void;
  onEdit: (p: Profile) => void; saving: boolean
}) {
  return <div className="admin-page">
    <div className="admin-summary-row">
      <div className="admin-summary"><Users size={19}/><div><strong>{people.length}</strong><small>Всего учётных записей</small></div></div>
      <div className="admin-summary"><CheckCircle2 size={19}/><div><strong>{people.filter((p) => p.is_active).length}</strong><small>Активных пользователей</small></div></div>
      <div className="admin-summary"><Ban size={19}/><div><strong>{people.filter((p) => !p.is_active).length}</strong><small>Заблокировано</small></div></div>
      <button className="button button-primary" onClick={() => setFormOpen(!formOpen)}><Plus size={16}/>{formOpen ? 'Скрыть форму' : 'Создать пользователя'}</button>
    </div>
    {formOpen && <section className="surface-card admin-form-card">
      <div className="card-heading"><div><h3>Новая учётная запись</h3><p>Логин и пароль для входа в портал</p></div><button className="icon-button" onClick={() => setFormOpen(false)}><X size={17}/></button></div>
      <form className="admin-form-grid" onSubmit={onSubmit}>
        <label>Логин<input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} pattern="[A-Za-z0-9_-]{3,40}" minLength={3} maxLength={40} placeholder="IVANOV01" required/><small>3–40 символов: латиница, цифры, дефис, подчёркивание</small></label>
        <label>Пароль<input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} minLength={12} placeholder="Не менее 12 символов" required/><small>Пароль не показывается повторно после создания</small></label>
        <label>Роль<select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role, business_unit_id: e.target.value === 'customer' ? draft.business_unit_id : '' })}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>{draft.role === 'customer' ? 'Бизнес-единица (необязательно)' : 'Бизнес-единица'}<select value={draft.business_unit_id} onChange={(e) => setDraft({ ...draft, business_unit_id: e.target.value })}><option value="">Не назначена</option>{units.filter((u) => u.kind === 'BE' && u.is_active).map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}</select></label>
        <label>БЕ по умолчанию (откуда)<select value={draft.default_from_id} onChange={(e) => setDraft({ ...draft, default_from_id: e.target.value })}><option value="">Не задана</option>{units.filter((u) => u.kind === 'BE' && u.is_active).map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}</select></label>
        <div className="form-submit"><button className="button button-primary" disabled={saving}>{saving ? 'Создаём…' : 'Создать учётную запись'}</button></div>
      </form>
      <div className="admin-form-note"><ShieldCheck size={15}/> Создание и смена логина выполняются через защищённые Edge Functions. Секретный ключ Supabase не передаётся в браузер.</div>
    </section>}
    <section className="surface-card table-card">
      <div className="card-heading table-card-heading"><div><h3>Пользователи портала</h3><p>Редактирование роли, БЕ, логина и доступа</p></div><span className="table-total">{people.length} записей</span></div>
      <div className="table-scroll"><table className="requests-table"><thead><tr><th>Пользователь</th><th>Роль</th><th>Бизнес-единица</th><th>Статус</th><th>Действия</th></tr></thead>
        <tbody>{people.map((person) => <tr key={person.id}>
          <td><div className="user-cell"><div className="avatar">{person.username.slice(0, 1).toUpperCase()}</div><div><strong>{person.username}</strong><small>{person.id.slice(0, 8)}…</small></div></div></td>
          <td><span className="role-pill">{roleNames[person.role]}</span></td>
          <td>{units.find((u) => u.id === person.business_unit_id)?.code || '—'}</td>
          <td><span className={`access-state ${person.is_active ? 'enabled' : 'disabled'}`}><i/>{person.is_active ? 'Активен' : 'Отключён'}</span></td>
          <td><div className="row-actions"><button className="icon-button small" onClick={() => onEdit(person)} title="Редактировать пользователя"><Pencil size={14}/></button><button className={`button button-compact ${person.is_active ? 'button-muted-danger' : 'button-outline'}`} onClick={() => onToggle(person)} disabled={person.id === currentUserId}>{person.is_active ? 'Отключить' : 'Включить'}</button></div></td>
        </tr>)}</tbody></table></div>
    </section>
  </div>
}

function UserEditModal({ person, units, draft, setDraft, onSubmit, onClose, saving, currentUserId }: {
  person: Profile; units: BusinessUnit[];
  draft: { username: string; password: string; role: Role; business_unit_id: string; default_from_id: string; is_active: boolean };
  setDraft: (v: any) => void; onSubmit: (e: FormEvent) => void; onClose: () => void; saving: boolean; currentUserId: string
}) {
  const isSelf = person.id === currentUserId
  const beUnits = units.filter((u) => u.kind === 'BE' && u.is_active)
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form className="request-modal user-edit-modal" onSubmit={onSubmit} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal-heading"><div><span className="modal-eyebrow">УПРАВЛЕНИЕ ДОСТУПОМ</span><h2>Редактирование пользователя</h2><p>{person.username} · {person.id.slice(0, 8)}…</p></div><button type="button" className="icon-button" onClick={onClose}><X size={18}/></button></div>
      <div className="modal-body"><div className="admin-form-grid user-edit-grid">
        <label>Логин<input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} pattern="[A-Za-z0-9_-]{3,40}" minLength={3} maxLength={40} required/><small>При смене логина обновится и имя для входа.</small></label>
        <label>Новый пароль<input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} minLength={12} maxLength={128} placeholder="Оставьте пустым без изменений"/><small>Не менее 12 символов; необязательно.</small></label>
        <label>Роль<select value={draft.role} disabled={isSelf} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role, business_unit_id: e.target.value === 'customer' ? draft.business_unit_id : '' })}>{Object.entries(roleNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label>{draft.role === 'customer' ? 'Бизнес-единица (необязательно)' : 'Бизнес-единица'}<select value={draft.business_unit_id} onChange={(e) => setDraft({ ...draft, business_unit_id: e.target.value })}><option value="">Не назначена</option>{beUnits.map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}</select></label>
        <label>БЕ по умолчанию (откуда)<select value={draft.default_from_id} onChange={(e) => setDraft({ ...draft, default_from_id: e.target.value })}><option value="">Не задана</option>{beUnits.map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}</select></label>
      </div>
      <label className="checkbox-line"><input type="checkbox" checked={draft.is_active} disabled={isSelf} onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}/><span><strong>Учётная запись активна</strong><small>Отключённый пользователь не сможет войти в портал.</small></span></label>
      {isSelf && <div className="admin-form-note"><ShieldCheck size={15}/> Нельзя снять собственную роль администратора или отключить свою учётную запись.</div>}
      </div>
      <div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Отмена</button><button className="button button-primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить изменения'} <Save size={15}/></button></div>
    </form>
  </div>
}

function DirectoryView({ units, formOpen, setFormOpen, draft, setDraft, onSubmit, onToggle, onEdit, saving }: {
  units: BusinessUnit[]; formOpen: boolean; setFormOpen: (v: boolean) => void; draft: UnitDraft; setDraft: (v: UnitDraft) => void;
  onSubmit: (e: FormEvent) => void; onToggle: (u: BusinessUnit) => void; onEdit: (u: BusinessUnit) => void; saving: boolean
}) {
  const closeForm = () => { setFormOpen(false); setDraft({ id: null, code: '', name: '', kind: 'BE', address: '' }) }
  return <div className="directory-page">
    <div className="directory-top"><div className="directory-stats"><div><strong>{units.filter((u) => u.kind === 'BE').length}</strong><span>Бизнес-единиц</span></div><div><strong>{units.filter((u) => u.kind === 'RC').length}</strong><span>Распределительных центров</span></div></div><button className="button button-primary" onClick={() => { if (formOpen) closeForm(); else setFormOpen(true) }}><Plus size={16}/>{formOpen ? 'Закрыть' : 'Добавить в справочник'}</button></div>
    {formOpen && <section className="surface-card admin-form-card"><div className="card-heading"><div><h3>{draft.id ? 'Редактирование записи' : 'Новая запись справочника'}</h3><p>{draft.id ? 'Изменение параметров выбранной БЕ или РЦ' : 'Добавление бизнес-единицы или РЦ'}</p></div><button type="button" className="icon-button" onClick={closeForm}><X size={17}/></button></div>
      <form className="admin-form-grid" onSubmit={onSubmit}><label>Код<input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} maxLength={30} placeholder="MSK01" required/></label><label>Название<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} placeholder="Название подразделения" required/></label><label>Тип<select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'BE' | 'RC' })}><option value="BE">Бизнес-единица</option><option value="RC">Распределительный центр</option></select></label><label>Адрес<input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} placeholder="Город, улица, дом"/></label><div className="form-submit"><button className="button button-primary" disabled={saving}>{saving ? 'Сохраняем…' : draft.id ? 'Сохранить изменения' : 'Добавить запись'}</button></div></form>
    </section>}
    <div className="directory-grid">{(['BE', 'RC'] as const).map((kind) => <section className="surface-card directory-card" key={kind}><div className="card-heading"><div><h3>{kind === 'BE' ? 'Бизнес-единицы' : 'Распределительные центры'}</h3><p>{units.filter((u) => u.kind === kind).length} записей</p></div><div className={`directory-icon ${kind === 'BE' ? 'be' : 'rc'}`}>{kind === 'BE' ? <Building2 size={18}/> : <Warehouse size={18}/>}</div></div><div className="unit-list">{units.filter((u) => u.kind === kind).map((unit) => <div className="unit-row" key={unit.id}><div className="unit-code">{unit.code.slice(0, 3)}</div><div className="unit-copy"><strong>{unit.code} · {unit.name}</strong><small>{unit.address || 'Адрес не указан'}</small></div><span className={`unit-state ${unit.is_active ? 'active' : 'inactive'}`}>{unit.is_active ? 'Активна' : 'Неактивна'}</span><button className="icon-button small" onClick={() => onEdit(unit)} title="Редактировать"><Pencil size={14}/></button><button className="icon-button small" onClick={() => onToggle(unit)} title={unit.is_active ? 'Деактивировать' : 'Активировать'}>{unit.is_active ? <Ban size={14}/> : <Check size={14}/>}</button></div>)}{!units.some((u) => u.kind === kind) && <div className="unit-empty">В этом разделе пока нет записей.</div>}</div></section>)}</div>
  </div>
}

function SettingsView({ bookingAdvanceDays, setBookingAdvanceDays, reserveSlotLimit, setReserveSlotLimit, roleLimits, setRoleLimits, onSubmit, saving, templateName, templateUploading, onTemplateUpload, onDownloadTemplate }: {
  bookingAdvanceDays: string; setBookingAdvanceDays: (v: string) => void; reserveSlotLimit: string; setReserveSlotLimit: (v: string) => void; roleLimits: RoleLimitValues;
  setRoleLimits: (v: RoleLimitValues) => void; onSubmit: (e: FormEvent) => void; saving: boolean;
  templateName: string | null; templateUploading: boolean; onTemplateUpload: (e: ChangeEvent<HTMLInputElement>) => void; onDownloadTemplate: () => void
}) {
  const roles: Role[] = ['customer', 'dispatcher', 'utz', 'admin']
  return <div className="settings-page">
    <form onSubmit={onSubmit} className="settings-layout">
      <section className="surface-card settings-card"><div className="card-heading"><div><h3>Лимиты заявок по ролям</h3><p>Максимум активных заявок одного пользователя за календарный месяц перевозки. Отменённые не учитываются; при создании администратором применяется лимит выбранного заказчика.</p></div><div className="directory-icon be"><SlidersHorizontal size={18}/></div></div>
        <div className="settings-role-list">{roles.map((role) => <label className="settings-role-row" key={role}><span><strong>{roleNames[role]}</strong><small>{roleDescriptions[role]}</small></span><span className="settings-number"><input type="number" min="1" max="10000" step="1" value={roleLimits[role]} onChange={(e) => setRoleLimits({ ...roleLimits, [role]: e.target.value })}/><small>заявок / месяц</small></span></label>)}</div>
      </section>
      <section className="surface-card settings-card"><div className="card-heading"><div><h3>Срок предварительной записи</h3><p>Минимальное количество дней между текущей датой и датой перевозки.</p></div><div className="directory-icon rc"><Clock3 size={18}/></div></div>
        <label className="advance-setting"><span><strong>Запись доступна за</strong><small>0 — день в день; 1 — только с завтрашнего дня; 2 — за два дня и т.д.</small></span><span className="settings-number"><input type="number" min="0" max="365" step="1" value={bookingAdvanceDays} onChange={(e) => setBookingAdvanceDays(e.target.value)}/><small>дней</small></span></label>
        <div className="settings-example"><strong>Текущая настройка:</strong> {Number(bookingAdvanceDays) === 0 ? 'заявку можно оформить на сегодня.' : `заявку можно оформить не ранее чем за ${bookingAdvanceDays} дн. до даты перевозки.`}</div>
      </section>
      <section className="surface-card settings-card reserve-slot-setting-card"><div className="card-heading"><div><h3>Резервные транспортные слоты</h3><p>Основной пул всегда содержит 3 слота и используется для направлений в РЦ. Резервный пул применяется для доставки на БЕ и другие адреса и не пересекается с основными слотами.</p></div><div className="directory-icon rc"><MapPin size={18}/></div></div>
        <label className="advance-setting"><span><strong>Количество резервных слотов в день</strong><small>0 — резервная запись отключена; допускается от 0 до 20 резервных слотов.</small></span><span className="settings-number"><input type="number" min="0" max="20" step="1" value={reserveSlotLimit} onChange={(e) => setReserveSlotLimit(e.target.value)}/><small>слотов / день</small></span></label>
        <div className="settings-example"><strong>Правило назначения:</strong> получатель — РЦ из справочника: основной слот; БЕ, другой адрес или адрес вручную: резервный слот.</div>
      </section>
      <section className="surface-card settings-card registry-template-card">
        <div className="card-heading"><div><h3>Шаблон реестра</h3><p>Файл, который заказчики смогут скачать в форме заявки и заполнить перед прикреплением к перевозке.</p></div><div className="directory-icon be"><FileText size={18}/></div></div>
        <div className="registry-template-current"><FileText size={18}/><span><strong>{templateName || 'Шаблон ещё не загружен'}</strong><small>{templateName ? 'Текущий шаблон доступен пользователям портала.' : 'Загрузите XLSX, XLS, CSV или ODS, размером до 20 МБ.'}</small></span></div>
        <div className="registry-template-actions">
          <label className="button button-primary"><Upload size={15}/>{templateUploading ? 'Загрузка…' : templateName ? 'Заменить шаблон' : 'Загрузить шаблон'}<input type="file" accept=".xlsx,.xls,.csv,.ods" onChange={onTemplateUpload} disabled={templateUploading} hidden/></label>
          {templateName && <button type="button" className="button button-secondary" onClick={onDownloadTemplate}><Download size={15}/> Скачать текущий</button>}
        </div>
      </section>
      <div className="settings-save-row"><span><ShieldCheck size={15}/> Ограничения проверяются на стороне базы данных.</span><button className="button button-primary" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить настройки'} <Save size={15}/></button></div>
    </form>
  </div>
}

function exportReportCsv(rows: ReportRow[], filename: string) {
  const headers = ['Показатель', 'Количество заявок', 'Среднее закрытие, дней', 'Закрыто', 'Не закрыто']
  const csvRows = rows.map((row) => [row.label, row.request_count, row.average_close_days ?? '', row.closed_count, row.open_count])
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const csv = '\uFEFF' + [headers, ...csvRows].map((row) => row.map(escape).join(';')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url)
}

function ReportsView({ rows, from, setFrom, to, setTo, loading, onGenerate }: {
  rows: ReportRow[]; from: string; setFrom: (value: string) => void; to: string; setTo: (value: string) => void;
  loading: boolean; onGenerate: () => void
}) {
  const bySection = (section: ReportRow['section']) => rows.filter((row) => row.section === section)
  const summary = bySection('summary')[0]
  const customers = bySection('customer')
  const origins = bySection('from')
  const destinations = bySection('to')
  const cargo = bySection('cargo')
  const closure = bySection('closing_speed')
  const statuses = bySection('status')
  const openStatuses = statuses.filter((row) => row.open_count > 0)
  const maxOf = (items: ReportRow[]) => Math.max(1, ...items.map((row) => Number(row.request_count) || 0))
  const renderBars = (items: ReportRow[], valueLabel: string) => <div className="report-bars">{items.length ? items.map((row) => <div className="report-bar-row" key={row.label} title={`${row.label}: ${row.request_count} заявок`}><div className="report-bar-meta"><span>{row.label}</span><b>{row.request_count}</b></div><div className="report-bar-track"><i style={{ width: `${Math.max(2, row.request_count / maxOf(items) * 100)}%` }}/></div>{valueLabel === 'days' && row.average_close_days !== null && <small>Среднее: {Number(row.average_close_days).toFixed(1)} дн.</small>}</div>) : <div className="report-empty">Нет данных за выбранный период.</div>}</div>
  const renderTable = (title: string, section: ReportRow['section'], rowsForTable: ReportRow[]) => <section className="surface-card report-table-card" key={section}>
    <div className="report-section-heading"><div><h3>{title}</h3><p>{rowsForTable.length} строк отчёта</p></div><button className="button button-secondary button-compact" disabled={!rowsForTable.length} onClick={() => exportReportCsv(rowsForTable, `akson-report-${section}-${from}-${to}.csv`)} title={`Выгрузить таблицу «${title}» в CSV`}><FileSpreadsheet size={14}/> CSV</button></div>
    {rowsForTable.length ? <div className="table-scroll"><table className="report-table"><thead><tr><th>Показатель</th><th>Заявок</th><th>Закрыто</th><th>Не закрыто</th><th>Среднее закрытие</th></tr></thead><tbody>{rowsForTable.map((row) => <tr key={row.label}><td>{row.label}</td><td><strong>{row.request_count}</strong></td><td>{row.closed_count}</td><td>{row.open_count}</td><td>{row.average_close_days === null ? '—' : `${Number(row.average_close_days).toFixed(1)} дн.`}</td></tr>)}</tbody></table></div> : <div className="report-empty">Нет данных за выбранный период.</div>}
  </section>

  return <div className="reports-page">
    <section className="surface-card reports-filter-card">
      <div className="reports-filter-copy"><strong>Отчётный период</strong><small>Период определяется по дате перевозки, а скорость закрытия — от создания заявки до статуса «Выполнена».</small></div>
      <label>С даты<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} title="Начало отчётного периода"/></label>
      <label>По дату<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} title="Конец отчётного периода"/></label>
      <button className="button button-primary" onClick={onGenerate} disabled={loading || !from || !to || from > to} title="Сформировать отчёты за выбранный период">{loading ? 'Формируем…' : 'Сформировать отчёт'} <Activity size={15}/></button>
    </section>
    {!rows.length ? <section className="surface-card empty-large"><EmptyState icon={Activity} title="Нет сформированного отчёта" text="Выберите период и нажмите «Сформировать отчёт»."/></section> : <>
      <div className="report-kpis-heading"><strong>Сводные показатели</strong><button className="button button-secondary button-compact" disabled={!summary} onClick={() => exportReportCsv(summary ? [summary] : [], `akson-report-summary-${from}-${to}.csv`)} title="Выгрузить сводные показатели отчёта в CSV"><FileSpreadsheet size={14}/> Сводка CSV</button></div>
      <div className="report-kpis">
        <article className="surface-card report-kpi"><span>Всего заявок</span><strong>{summary?.request_count ?? 0}</strong><small>За выбранный период</small></article>
        <article className="surface-card report-kpi"><span>Закрыто</span><strong>{summary?.closed_count ?? 0}</strong><small>Статус «Выполнена»</small></article>
        <article className="surface-card report-kpi"><span>Не закрыто</span><strong>{summary?.open_count ?? 0}</strong><small>Создана, поиск или подтверждена</small></article>
        <article className="surface-card report-kpi"><span>Средний срок закрытия</span><strong>{summary?.average_close_days === null || summary?.average_close_days === undefined ? '—' : `${Number(summary.average_close_days).toFixed(1)}`}</strong><small>Дней от создания до выполнения</small></article>
      </div>
      <div className="reports-grid">
        {renderTable('Заявки по заказчикам', 'customer', customers)}
        {renderTable('Заявки по отправлению — откуда', 'from', origins)}
        {renderTable('Заявки по назначению — куда', 'to', destinations)}
      </div>
      <div className="reports-grid reports-charts-grid">
        <section className="surface-card report-chart-card"><div className="report-section-heading"><div><h3>Заявки по типу груза</h3><p>Количество заявок каждого типа</p></div><button className="button button-secondary button-compact" disabled={!cargo.length} onClick={() => exportReportCsv(cargo, `akson-report-cargo-${from}-${to}.csv`)} title="Выгрузить данные по типу груза"><FileSpreadsheet size={14}/> CSV</button></div>{renderBars(cargo, 'count')}</section>
        <section className="surface-card report-chart-card"><div className="report-section-heading"><div><h3>Скорость закрытия</h3><p>Распределение выполненных заявок по дням</p></div><button className="button button-secondary button-compact" disabled={!closure.length} onClick={() => exportReportCsv(closure, `akson-report-closing-speed-${from}-${to}.csv`)} title="Выгрузить скорость закрытия в CSV"><FileSpreadsheet size={14}/> CSV</button></div>{renderBars(closure, 'days')}</section>
        <section className="surface-card report-chart-card"><div className="report-section-heading"><div><h3>Незакрытые заявки</h3><p>Количество заявок в каждом активном статусе</p></div><button className="button button-secondary button-compact" disabled={!openStatuses.length} onClick={() => exportReportCsv(openStatuses, `akson-report-open-${from}-${to}.csv`)} title="Выгрузить количество незакрытых заявок по статусам"><FileSpreadsheet size={14}/> CSV</button></div>{renderBars(openStatuses, 'count')}</section>
      </div>
      <div className="report-footer-note">Все таблицы и графики рассчитаны по дате перевозки. Скорость закрытия учитывает только заявки, которые получили статус «Выполнена» в истории статусов.</div>
    </>}
  </div>
}

function HistoryView({ rows, people, hasMore, loadingMore, onLoadMore, search, setSearch, entity, setEntity, from, setFrom, to, setTo, onRefresh }: {
  rows: AuditRecord[]; people: Profile[]; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; search: string; setSearch: (v: string) => void; entity: string; setEntity: (v: string) => void;
  from: string; setFrom: (v: string) => void; to: string; setTo: (v: string) => void; onRefresh: () => void
}) {
  const actionTitles: Record<string, string> = {
    create: 'Создана заявка', request_update: 'Изменена заявка', request_status_update: 'Изменён статус заявки',
    reschedule: 'Перенесена заявка', cargo_add: 'Добавлен груз', cargo_update: 'Изменён состав груза', cargo_remove: 'Удалён груз',
    profile_create: 'Создан пользователь', profile_update: 'Изменён пользователь', profile_access_update: 'Изменён доступ пользователя', request_registry_update: 'Изменён файл реестра заявки',
    directory_create: 'Добавлена запись справочника', directory_update: 'Изменён справочник', directory_delete: 'Удалена запись справочника',
    settings_create: 'Созданы настройки', settings_update: 'Изменены настройки', settings_delete: 'Удалены настройки'
  }
  const entityTitles: Record<string, string> = {
    transport_request: 'Заявка', request_cargo: 'Груз заявки', profile: 'Пользователь', business_unit: 'Справочник',
    role_request_limit: 'Лимит роли', portal_settings: 'Общие настройки'
  }
  const filtered = useMemo(() => rows.filter((row) => {
    const actor = row.actor_username || people.find((person) => person.id === row.actor_id)?.username || ''
    const haystack = `${actor} ${row.action} ${row.entity_type} ${row.entity_id || ''} ${JSON.stringify(row.details || {})}`.toLowerCase()
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.created_at))
    return (entity === 'all' || row.entity_type === entity)
      && (!from || day >= from) && (!to || day <= to)
      && (!search.trim() || haystack.includes(search.trim().toLowerCase()))
  }), [rows, people, search, entity, from, to])
  return <div className="history-page">
    <section className="surface-card history-filters"><div className="search-field"><Search size={16}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по пользователю, действию или деталям" title="Поиск по автору, типу действия, объекту и описанию изменений"/></div><select className="history-entity" value={entity} onChange={(e) => setEntity(e.target.value)} title="Оставить в истории только выбранный тип объектов"><option value="all">Все объекты</option><option value="transport_request">Заявки</option><option value="request_cargo">Груз заявок</option><option value="profile">Пользователи</option><option value="business_unit">Справочник</option><option value="role_request_limit">Лимиты ролей</option><option value="portal_settings">Общие настройки</option></select><label className="history-date" title="Начало периода журнала действий">С даты<input type="date" value={from} onChange={(e) => setFrom(e.target.value)}/></label><label className="history-date" title="Окончание периода журнала действий">По дату<input type="date" value={to} onChange={(e) => setTo(e.target.value)}/></label><button className="button button-secondary button-compact" onClick={() => onRefresh()}><RefreshCw size={14}/> Обновить</button></section>
    <div className="history-results-head"><strong>Показано событий: {filtered.length}</strong><span>Загружено: {rows.length}</span></div>
    {filtered.length ? <div className="history-list">{filtered.map((row) => {
      const actor = row.actor_username || people.find((person) => person.id === row.actor_id)?.username || 'Системный процесс'
      const title = actionTitles[row.action] || row.action
      const details = row.details || {}
      const identifier = details.request_no ? `№${details.request_no}` : details.username || details.role || ''
      return <article className="surface-card history-entry" key={row.id}>
        <div className="history-entry-icon"><HistoryIcon size={17}/></div>
        <div className="history-entry-main"><div className="history-entry-top"><strong>{title}{identifier ? ` · ${identifier}` : ''}</strong><time>{new Date(row.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></div><div className="history-entry-meta"><span>{actor}</span><i>·</i><span>{entityTitles[row.entity_type] || row.entity_type}</span>{row.entity_id && <small>ID: {row.entity_id.slice(0, 8)}…</small>}</div><details><summary>Подробности изменения</summary><pre>{JSON.stringify(details, null, 2)}</pre></details></div>
      </article>
    })}</div> : <section className="surface-card empty-large"><EmptyState icon={Search} title="События не найдены" text="Попробуйте изменить поисковый запрос или фильтр дат."/></section>}
    {hasMore && <div className="history-load-more"><button className="button button-secondary" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? 'Загружаем…' : 'Загрузить ещё 500 событий'}</button></div>}
  </div>
}

function RequestModal({ units, people, profile, occupancy, bookingAdvanceDays, reserveSlotLimit, request, slot, initialDate, onClose, onSave, onUploadRegistry, saving, registryTemplateName, registryTemplatePath, onDownloadTemplate, onDownloadRegistry }: {
  units: BusinessUnit[]; people: Profile[]; profile: Profile; occupancy: SlotOccupancy[]; bookingAdvanceDays: number; reserveSlotLimit: number; request?: TransportRequest; slot?: number; initialDate?: string;
  onClose: () => void; onSave: (payload: RequestDraft, request?: TransportRequest) => Promise<void>;
  onUploadRegistry: (request: TransportRequest, file: File) => Promise<{ path: string; name: string }>;
  saving: boolean; registryTemplateName: string | null; registryTemplatePath: string | null; onDownloadTemplate: () => void;
  onDownloadRegistry: (path: string | null | undefined, name?: string | null) => void
}) {
  const isStaff = profile.role === 'dispatcher' || profile.role === 'admin'
  const isOwnRequest = !!request && request.requester_id === profile.id
  const customerOptions = people.filter((person) => {
    const assignedBe = person.business_unit_id ? units.find((unit) => unit.id === person.business_unit_id && unit.kind === 'BE') : null
    const isCurrentRequester = person.id === request?.requester_id
    return person.role === 'customer' && (!person.business_unit_id || !!assignedBe && assignedBe.is_active || isCurrentRequester) && (person.is_active || isCurrentRequester)
  })
  const canEditFields = request
    ? isStaff || (profile.role === 'customer' && isOwnRequest && request.status === 'created')
    : profile.role === 'customer' || isStaff
  const canEditRegistry = request
    ? isStaff || (profile.role === 'customer' && isOwnRequest && !['completed', 'cancelled'].includes(request.status))
    : profile.role === 'customer' || isStaff
  const canChooseRequester = profile.role === 'admin' || (profile.role === 'dispatcher' && !request)
  const [editing, setEditing] = useState(!request)
  const [requesterId, setRequesterId] = useState(request?.requester_id || (profile.role === 'admin' || profile.role === 'dispatcher' ? '' : profile.id))
  const initialRequester = people.find((person) => person.id === (request?.requester_id || profile.id))
  const minimumDate = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + (isStaff ? 0 : bookingAdvanceDays)))
  const [date, setDate] = useState(request?.transport_date || (initialDate && initialDate >= minimumDate ? initialDate : minimumDate))
  const [slotNo, setSlotNo] = useState(request?.slot_number || slot || 1)
  const [from, setFrom] = useState(request ? (request.from_unit_id || (request.from_other_address ? 'other' : '')) : (initialRequester?.default_from_id || initialRequester?.business_unit_id || ''))
  const [fromOther, setFromOther] = useState(request?.from_other_address || '')
  const [to, setTo] = useState(request ? (request.to_unit_id || (request.to_other_address ? 'other' : '')) : '')
  const [toOther, setToOther] = useState(request?.to_other_address || '')
  const [capacity, setCapacity] = useState(String(request?.capacity_tons || '5'))
  const [loadingType, setLoadingType] = useState<'rear' | 'side'>(request?.loading_type || 'rear')
  const [cargo, setCargo] = useState<string[]>(request?.request_cargo?.map((x) => x.cargo_type) || [])
  const [stock, setStock] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'goods')?.stock_pallets || 0))
  const [kdk, setKdk] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'goods')?.kdk_pallets || 0))
  const [packaging, setPackaging] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'packaging')?.packaging_qty || 0))
  const [equipmentPalletPlaces, setEquipmentPalletPlaces] = useState(String(request?.request_cargo?.find((x) => x.cargo_type === 'equipment')?.equipment_pallet_places || 0))
  const [transportTaskNumber, setTransportTaskNumber] = useState(request?.transport_task_number || '')
  const [requestComment, setRequestComment] = useState(request?.request_comment || '')
  const [formError, setFormError] = useState('')
  const [copiedField, setCopiedField] = useState('')
  const [registryFile, setRegistryFile] = useState<File | null>(null)
  const [currentRegistryPath, setCurrentRegistryPath] = useState(request?.registry_file_path || null)
  const [currentRegistryName, setCurrentRegistryName] = useState(request?.registry_file_name || null)
  const [registryUploading, setRegistryUploading] = useState(false)
  const existingRegistryPath = currentRegistryPath || request?.registry_file_path || null
  const existingRegistryName = currentRegistryName || request?.registry_file_name || null
  const canDownloadCurrentRegistry = !!request && (profile.role === 'dispatcher' || profile.role === 'utz' || profile.role === 'admin' || (profile.role === 'customer' && isOwnRequest))
  const editableFields = editing && canEditFields
  const registryCanUpload = editing && canEditRegistry
  const registryOnlyMode = !!request && profile.role === 'customer' && request.status !== 'created'
  const be = units.filter((u) => u.kind === 'BE' && (u.is_active || u.id === request?.from_unit_id))
  const destinations = units.filter((u) => u.is_active || u.id === request?.to_unit_id)
  const fromUnitSelected = units.find((u) => u.id === from)
  const toUnitSelected = units.find((u) => u.id === to)
  const originAddressValue = from === 'other' ? fromOther.trim() : (fromUnitSelected?.address || '').trim()
  const destinationAddressValue = to === 'other' ? toOther.trim() : (toUnitSelected?.address || '').trim()
  const targetSlotType: 'main' | 'reserve' = to !== 'other' && toUnitSelected?.kind === 'RC' ? 'main' : 'reserve'
  const targetSlotLimit = targetSlotType === 'main' ? 3 : reserveSlotLimit
  const sameOriginalDestination = !!request && (request.to_unit_id
    ? to === request.to_unit_id
    : to === 'other' && toOther.trim() === (request.to_other_address || '').trim())
  const preservesExistingAllocation = !!request
    && request.status !== 'cancelled'
    && request.transport_date === date
    && request.slot_type === targetSlotType
    && request.slot_number === slotNo
    && sameOriginalDestination
  const slotIsOccupied = (candidate: number) => occupancy.some((r) => r.transport_date === date && r.slot_number === candidate && r.slot_type === targetSlotType && !(request?.transport_date === date && request.slot_number === candidate && request.slot_type === targetSlotType))
  useEffect(() => {
    if (preservesExistingAllocation) return
    const currentIsFree = slotNo <= targetSlotLimit && !slotIsOccupied(slotNo)
    if (currentIsFree || targetSlotLimit < 1) return
    const nextFree = Array.from({ length: targetSlotLimit }, (_, i) => i + 1).find((candidate) => !slotIsOccupied(candidate))
    if (nextFree) setSlotNo(nextFree)
  }, [date, targetSlotType, targetSlotLimit, occupancy, request?.id, request?.to_unit_id, request?.to_other_address, slotNo, to, toOther, preservesExistingAllocation])
  const occupied = slotIsOccupied(slotNo)

  async function copyField(key: string, value: string) {
    const textToCopy = String(value || '').trim()
    if (!textToCopy) return
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(textToCopy)
      } else {
        const helper = document.createElement('textarea')
        helper.value = textToCopy
        helper.setAttribute('readonly', '')
        helper.style.position = 'fixed'
        helper.style.opacity = '0'
        helper.style.left = '-9999px'
        document.body.appendChild(helper)
        helper.select()
        const copied = document.execCommand('copy')
        helper.remove()
        if (!copied) throw new Error('Clipboard copy was rejected')
      }
      setCopiedField(key)
      setFormError('')
    } catch {
      setCopiedField('')
      setFormError('Не удалось скопировать значение. Выделите текст и скопируйте его вручную.')
    }
  }

  function toggleCargo(value: string) { setCargo((old) => old.includes(value) ? old.filter((x) => x !== value) : [...old, value]) }

  async function uploadRegistryNow() {
    if (!request || !registryFile) return
    setRegistryUploading(true); setFormError('')
    try {
      const result = await onUploadRegistry(request, registryFile)
      setCurrentRegistryPath(result.path); setCurrentRegistryName(result.name); setRegistryFile(null)
    } catch (e) { setFormError(errorText(e)) }
    finally { setRegistryUploading(false) }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setFormError('')
    try {
      if (!editableFields) throw new Error('Для изменения полей заявки нажмите пиктограмму редактирования.')
      if (canChooseRequester && !requesterId) throw new Error('Выберите заказчика.')
      if (isStaff && date < iso(today)) throw new Error('Создавать и переносить заявки на прошедшую дату нельзя. Для сотрудников минимальная дата — сегодня.')
      if (!isStaff && (!request || date !== request.transport_date) && date < minimumDate) throw new Error(`Дата перевозки должна быть не ранее ${dateLabel(minimumDate)}.`)
      if (!from || (from === 'other' ? !fromOther.trim() : !units.some((u) => u.id === from && u.kind === 'BE')) ) throw new Error('Для поля «Откуда» выберите БЕ из списка или «Другой адрес» и укажите адрес вручную.')
      if (!to || (to === 'other' ? !toOther.trim() : !units.some((u) => u.id === to && (u.is_active || u.id === request?.to_unit_id)))) throw new Error('Для поля «Куда» выберите БЕ/РЦ из списка или «Другой адрес» и укажите адрес вручную.')
      if (targetSlotLimit < 1 && !preservesExistingAllocation) throw new Error(targetSlotType === 'main' ? 'Основной пул временно недоступен.' : 'Резервные слоты отключены администратором. Существующую заявку можно сохранить без изменения её даты, назначения и слота.')
      if (!cargo.length) throw new Error('Выберите хотя бы один вид груза.')
      if (transportTaskNumber.length > 44) throw new Error('Номер задания на перевозку не должен превышать 44 символа.')
      if (requestComment.length > 320) throw new Error('Комментарий не должен превышать 320 символов.')
      if (registryFile) {
        const extension = registryFile.name.split('.').pop()?.toLowerCase() || ''
        if (!['xlsx', 'xls', 'csv', 'ods'].includes(extension)) throw new Error('Реестр должен быть в формате XLSX, XLS, CSV или ODS.')
        if (registryFile.size > 20 * 1024 * 1024) throw new Error('Размер реестра не должен превышать 20 МБ.')
      }
      if (occupied) throw new Error('Этот слот уже занят. Выберите другой слот или дату.')
      if (cargo.includes('goods') && Number(stock) + Number(kdk) <= 0) throw new Error('Укажите количество паллет Сток и/или КДК.')
      if (cargo.includes('packaging') && Number(packaging) <= 0) throw new Error('Укажите количество тары.')
      if (cargo.includes('equipment') && (!Number.isInteger(Number(equipmentPalletPlaces)) || Number(equipmentPalletPlaces) <= 0)) throw new Error('Укажите количество грузомест оборудования в паллетоместах.')
      await onSave({ requester_id: canChooseRequester ? requesterId : undefined, transport_date: date, slot_number: slotNo, slot_type: targetSlotType, from_unit_id: from === 'other' ? null : from, from_other_address: from === 'other' ? fromOther.trim() : null, to_unit_id: to === 'other' ? null : to, to_other_address: to === 'other' ? toOther.trim() : null, capacity_tons: Number(capacity), loading_type: loadingType, cargo_types: cargo, stock_pallets: Number(stock || 0), kdk_pallets: Number(kdk || 0), packaging_qty: Number(packaging || 0), equipment_pallet_places: Number(equipmentPalletPlaces || 0), registry_file: registryFile, transport_task_number: transportTaskNumber, request_comment: requestComment }, request)
    } catch (e) { setFormError(errorText(e)) }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="request-modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="modal-eyebrow">ТРАНСПОРТНАЯ ЗАЯВКА</span>
            <h2>{request ? `Заявка №${request.request_no}` : 'Новая заявка'}</h2>
            <p>{request ? `${request.profiles?.username || profile.username} · ${statusNames[request.status]}` : (people.find((person) => person.id === requesterId)?.username || profile.username)} · {request ? (editing ? 'Редактирование данных' : 'Просмотр данных') : 'Заполните параметры перевозки'}</p>
          </div>
          <div className="request-modal-heading-actions">
            {request && (canEditFields || canEditRegistry) && <button type="button" className={`icon-button ${editing ? 'active' : ''}`} onClick={() => { setEditing((v) => !v); setFormError('') }} title={editing ? 'Перейти в режим просмотра' : 'Редактировать заявку'} aria-label={editing ? 'Перейти в режим просмотра' : 'Редактировать заявку'}><Pencil size={17}/></button>}
            <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть окно" title="Закрыть окно"><X size={18}/></button>
          </div>
        </div>

        <div className="modal-body request-modal-body">
          {request && <div className="request-view-status"><span>Текущий статус</span><StatusBadge status={request.status}/></div>}
          {(profile.role === 'admin' || (profile.role === 'dispatcher' && !request)) && <>
            <div className="form-section-label">Заказчик заявки</div>
            <label className="modal-full-field">
              Пользователь
              <select value={requesterId} onChange={(e) => {
                const nextId = e.target.value
                setRequesterId(nextId)
                const nextPerson = people.find((person) => person.id === nextId)
                if (!request) setFrom(be.find((unit) => unit.id === nextPerson?.default_from_id)?.id || be.find((unit) => unit.id === nextPerson?.business_unit_id)?.id || '')
              }} required disabled={!editableFields}>
                <option value="">Выберите заказчика</option>
                {customerOptions.map((person) => <option key={person.id} value={person.id}>{person.username}{!person.is_active ? ' · отключён' : ''} — {units.find((unit) => unit.id === person.business_unit_id)?.code || 'БЕ не назначена'}</option>)}
              </select>
            </label>
          </>}
          {request && profile.role === 'dispatcher' && <div className="request-view-meta"><span>Заказчик</span><strong>{request.profiles?.username || 'Не указан'}</strong></div>}
          {request && <div className="request-view-meta"><span>БЕ профиля заказчика</span><strong>{request.business_units?.code ? `${request.business_units.code} — ${request.business_units.name}` : 'Не назначена'}</strong></div>}

          <div className="form-section-label">Дата и слот</div>
          <div className="form-grid-two request-field-grid">
            <label className="request-field"><span>Дата перевозки</span><input type="date" value={date} min={editableFields ? minimumDate : undefined} onChange={(e) => setDate(e.target.value)} required disabled={!editableFields} title={isStaff ? 'Диспетчер и администратор могут назначить текущую или будущую дату.' : 'Дата ограничена настройкой срока предварительной записи.'}/><small className="field-hint">{isStaff ? 'Для сотрудников: сегодня или позже.' : `Минимальный срок подачи: ${bookingAdvanceDays} дн.`}</small></label>
            <label className="request-field"><span>{targetSlotType === 'main' ? 'Основной слот (направление в РЦ)' : 'Резервный слот (другой адрес)'}</span><select value={slotNo} onChange={(e) => setSlotNo(Number(e.target.value))} disabled={!editableFields || (targetSlotLimit === 0 && !preservesExistingAllocation)} title={targetSlotType === 'main' ? 'Основной пул: 3 независимых слота для направления в РЦ.' : `Резервный пул: ${reserveSlotLimit} независимых слотов для БЕ и других адресов.`}>{[...Array.from({ length: targetSlotLimit }, (_, i) => i + 1), ...(preservesExistingAllocation && slotNo > targetSlotLimit ? [slotNo] : [])].map((n) => <option value={n} key={n}>Слот {n}{n > targetSlotLimit ? ' · текущий, сохранён' : ''}</option>)}</select><small className="field-hint">{targetSlotType === 'main' ? 'Основные слоты не пересекаются с резервными.' : `В резервном пуле настроено: ${reserveSlotLimit}.${preservesExistingAllocation ? ' Текущий слот сохранён за этой заявкой.' : ''}`}</small></label>
          </div>

          <div className="form-section-label">Маршрут</div>
          <div className="form-grid-two request-field-grid">
            <div className="request-field-group"><label htmlFor="request-from">Откуда <span className="required-mark">*</span></label><select id="request-from" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value !== 'other') setFromOther('') }} disabled={!editableFields} title="Выберите БЕ отправления или вариант «Другой адрес»."><option value="">Выберите БЕ</option>{be.map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}<option value="other">Другой адрес</option></select><div className="request-subfield"><div className="request-subfield-heading"><label htmlFor="request-from-address">Адрес отправления</label>{!!request && !!originAddressValue && <button type="button" className="copy-field-button" onClick={() => copyField('origin-address', originAddressValue)} title="Скопировать адрес отправления" aria-label="Скопировать адрес отправления">{copiedField === 'origin-address' ? <Check size={14}/> : <Copy size={14}/>}</button>}</div><input id="request-from-address" value={from === 'other' ? fromOther : fromUnitSelected?.address || ''} onChange={(e) => setFromOther(e.target.value)} disabled={!editableFields || !from} readOnly={from !== 'other'} placeholder={from ? (from === 'other' ? 'Укажите адрес вручную' : 'Адрес из справочника') : 'Сначала выберите БЕ или «Другой адрес»'}/>{from && from !== 'other' && !fromUnitSelected?.address && <small className="field-hint">Адрес для выбранной БЕ не заполнен в справочнике. Обратитесь к администратору.</small>}</div></div>
            <div className="request-field-group"><label htmlFor="request-to">Куда <span className="required-mark">*</span></label><select id="request-to" value={to} onChange={(e) => { setTo(e.target.value); if (e.target.value !== 'other') setToOther(''); setSlotNo(1) }} disabled={!editableFields} title="Выберите РЦ, БЕ или вариант «Другой адрес»."><option value="">Выберите БЕ или РЦ</option>{destinations.map((u) => <option value={u.id} key={u.id}>{u.code} — {u.name}</option>)}<option value="other">Другой адрес</option></select><div className="request-subfield"><div className="request-subfield-heading"><label htmlFor="request-to-address">Адрес назначения</label>{!!request && !!destinationAddressValue && <button type="button" className="copy-field-button" onClick={() => copyField('destination-address', destinationAddressValue)} title="Скопировать адрес назначения" aria-label="Скопировать адрес назначения">{copiedField === 'destination-address' ? <Check size={14}/> : <Copy size={14}/>}</button>}</div><input id="request-to-address" value={to === 'other' ? toOther : toUnitSelected?.address || ''} onChange={(e) => setToOther(e.target.value)} disabled={!editableFields || !to} readOnly={to !== 'other'} placeholder={to ? (to === 'other' ? 'Укажите адрес вручную' : 'Адрес из справочника') : 'Сначала выберите РЦ/БЕ или «Другой адрес»'}/>{to && to !== 'other' && !toUnitSelected?.address && <small className="field-hint">Адрес для выбранного подразделения не заполнен в справочнике. Обратитесь к администратору.</small>}</div></div>
          </div>

          <div className="form-section-label">Параметры транспорта</div>
          <div className="form-grid-two request-field-grid">
            <div className="field-block request-option-field"><span>Грузоподъёмность</span><div className="segmented-options">{['1.5', '5', '10', '20'].map((value) => <button type="button" key={value} className={capacity === value ? 'selected' : ''} onClick={() => setCapacity(value)} disabled={!editableFields}>{value.replace('.', ',')} т</button>)}</div></div>
            <div className="field-block request-option-field"><span>Тип погрузки</span><div className="segmented-options">{(['rear', 'side'] as const).map((value) => <button type="button" key={value} className={loadingType === value ? 'selected' : ''} onClick={() => setLoadingType(value)} disabled={!editableFields}>{value === 'rear' ? 'Задняя' : 'Боковая'}</button>)}</div></div>
          </div>

          <div className="form-section-label">Состав груза</div>
          <div className="cargo-tiles request-cargo-tiles" title="Отметьте все типы груза, которые входят в заявку.">{([['goods', 'Товар', Package], ['equipment', 'Оборудование', Warehouse], ['packaging', 'Тара', Layers3]] as const).map(([value, label, Icon]) => <button type="button" key={value} className={cargo.includes(value) ? 'cargo-tile active' : 'cargo-tile'} onClick={() => toggleCargo(value)} disabled={!editableFields}><Icon size={23}/><strong>{label}</strong><span>{cargo.includes(value) ? 'Выбрано' : 'Добавить'}</span></button>)}</div>
          {(cargo.includes('goods') || cargo.includes('packaging') || cargo.includes('equipment')) && <div className="form-grid-two request-field-grid cargo-quantities request-quantity-grid">
            {cargo.includes('goods') && <><label className="request-field request-quantity-field" title="Количество паллетомест товарного запаса Сток."><span>Сток, паллетомест</span><input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} disabled={!editableFields}/></label><label className="request-field request-quantity-field" title="Количество паллетомест категории Кросс док."><span>Кросс док, паллетомест</span><input type="number" min="0" value={kdk} onChange={(e) => setKdk(e.target.value)} disabled={!editableFields}/></label></>}
            {cargo.includes('packaging') && <label className="request-field request-quantity-field" title="Количество единиц тары в штуках."><span>Тара, шт.</span><input type="number" min="1" value={packaging} onChange={(e) => setPackaging(e.target.value)} disabled={!editableFields}/></label>}
            {cargo.includes('equipment') && <label className="request-field request-quantity-field" title="Количество грузомест оборудования в паллетоместах."><span>Оборудование, паллетомест</span><input type="number" min="1" step="1" value={equipmentPalletPlaces} onChange={(e) => setEquipmentPalletPlaces(e.target.value)} placeholder="Например, 4" required disabled={!editableFields}/></label>}
          </div>}

          {request?.dispatcher_comment && <div className="request-view-meta"><span>Комментарий диспетчера</span><strong>{request.dispatcher_comment}</strong></div>}
          <div className="form-section-label">Дополнительные сведения <small className="optional-label">необязательно</small></div>
          <div className="form-grid-two request-field-grid">
            <div className="request-field"><div className="request-field-heading"><label htmlFor="request-task-number">Номер задания на перевозку</label>{!!request && !!transportTaskNumber.trim() && <button type="button" className="copy-field-button" onClick={() => copyField('task-number', transportTaskNumber)} title="Скопировать номер задания на перевозку" aria-label="Скопировать номер задания на перевозку">{copiedField === 'task-number' ? <Check size={14}/> : <Copy size={14}/>}</button>}</div><input id="request-task-number" value={transportTaskNumber} onChange={(e) => setTransportTaskNumber(e.target.value.slice(0, 44))} maxLength={44} placeholder="До 44 символов" disabled={!editableFields}/><small className="field-hint">{transportTaskNumber.length}/44 символа</small></div>
            <div className="request-field"><div className="request-field-heading"><label htmlFor="request-comment">Комментарий</label>{!!request && !!requestComment.trim() && <button type="button" className="copy-field-button" onClick={() => copyField('request-comment', requestComment)} title="Скопировать комментарий" aria-label="Скопировать комментарий">{copiedField === 'request-comment' ? <Check size={14}/> : <Copy size={14}/>}</button>}</div><textarea id="request-comment" value={requestComment} onChange={(e) => setRequestComment(e.target.value.slice(0, 320))} maxLength={320} rows={2} placeholder="До 320 символов" disabled={!editableFields}/><small className="field-hint">{requestComment.length}/320 символов</small></div>
          </div>

          <div className="form-section-label">Реестр к заявке <small className="optional-label">необязательно</small></div>
          <div className="registry-attachment-panel">
            <div className="registry-attachment-actions">
              {registryCanUpload && <label className="button button-secondary registry-file-picker"><Upload size={15}/>{registryFile || currentRegistryName ? 'Заменить реестр' : 'Добавить реестр'}<input type="file" accept=".xlsx,.xls,.csv,.ods" onChange={(e) => { setRegistryFile(e.target.files?.[0] || null); e.currentTarget.value = '' }} hidden/></label>}
              <button type="button" className="button button-secondary" onClick={onDownloadTemplate} disabled={!registryTemplatePath} title={registryTemplatePath ? `Скачать шаблон ${registryTemplateName || ''}` : 'Администратор ещё не загрузил шаблон'}><Download size={15}/> Скачать шаблон</button>
            </div>
            {registryFile && <div className="registry-file-status"><FileText size={16}/><span>Выбран файл: <strong>{registryFile.name}</strong><small>{(registryFile.size / 1024 / 1024).toFixed(2)} МБ</small></span>{request && registryOnlyMode ? <button type="button" className="button button-primary button-compact" onClick={uploadRegistryNow} disabled={registryUploading}>{registryUploading ? 'Загружаем…' : 'Загрузить реестр'}</button> : <button type="button" className="icon-button small" onClick={() => setRegistryFile(null)} title="Отменить выбор файла"><X size={14}/></button>}</div>}
            {existingRegistryPath && canDownloadCurrentRegistry && <div className="registry-file-status registry-current-file"><FileText size={16}/><span>Текущий реестр: <strong>{existingRegistryName || 'Вложенный реестр'}</strong><small>Файл, прикреплённый к этой заявке</small></span><button type="button" className="button button-secondary button-compact" onClick={() => onDownloadRegistry(existingRegistryPath, existingRegistryName || 'Реестр_заявки')} title="Скачать текущий реестр заявки"><Download size={14}/> Скачать реестр</button></div>}
            {!registryFile && !existingRegistryPath && <p className="registry-file-hint">Реестр прикладывается по желанию. Форматы: XLSX, XLS, CSV, ODS. Максимальный размер — 20 МБ.</p>}
            {registryOnlyMode && canEditRegistry && <small className="field-hint">Заказчик может загрузить или заменить реестр до статуса «Выполнена» или «Отменена».</small>}
          </div>

          {occupied && editableFields && <div className="message message-error"><AlertCircle size={16}/> Этот слот уже занят другой заявкой.</div>}
          {formError && <div className="message message-error"><AlertCircle size={16}/>{formError}</div>}
        </div>

        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>Закрыть</button>
          {editableFields && <button className="button button-primary" disabled={saving || !!occupied}>{saving ? 'Сохранение…' : 'Сохранить заявку'} <ArrowRight size={16}/></button>}
        </div>
      </form>
    </div>
  )
}

function MonthControls({ month, setMonth }: { month: Date; setMonth: (v: Date) => void }) {
  return <div className="month-controls"><button className="icon-button" title="Предыдущий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={17}/></button><strong>{monthTitle(month)}</strong><button className="icon-button" title="Следующий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={17}/></button></div>
}
function StatusBadge({ status }: { status: RequestStatus }) { return <span className={`status-badge ${statusClasses[status]}`}><i/>{statusNames[status]}</span> }
function EmptyState({ icon: Icon, title, text }: { icon: typeof Search; title: string; text: string }) { return <div className="empty-state"><div><Icon size={25}/></div><strong>{title}</strong><p>{text}</p></div> }
function resolveUnit(units: BusinessUnit[], id: string | null, other: string | null) { if (other) return other; const unit = units.find((u) => u.id === id); return unit ? `${unit.code}` : 'Не указано' }

export default App
