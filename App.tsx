import { useEffect, useMemo, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase'
import type { BusinessUnit, CargoLine, Profile, RequestStatus, Role, TransportRequest } from './types'
import { Package, Warehouse, PanelsTopLeft, ChevronLeft, ChevronRight, Plus, LogOut, Settings, Users, Truck, X, Pencil, Trash2, CalendarDays, ArrowLeftRight } from 'lucide-react'

const roleNames: Record<Role,string> = { customer:'Заказчик', dispatcher:'Диспетчер', utz:'УТЗ', admin:'Администратор' }
const statusNames: Record<RequestStatus,string> = { created:'Создан', search:'Поиск', confirmed:'Подтвержден', completed:'Выполнен', cancelled:'Отменён' }
const today = new Date()
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
const monthTitle = (d: Date) => d.toLocaleDateString('ru-RU',{month:'long',year:'numeric'})
const dateKey = (d: Date) => iso(d)

function App() {
  const [session, setSession] = useState<any>(null)
  const [profile, setProfile] = useState<Profile|null>(null)
  const [units, setUnits] = useState<BusinessUnit[]>([])
  const [requests, setRequests] = useState<TransportRequest[]>([])
  const [month, setMonth] = useState(new Date(today.getFullYear(),today.getMonth(),1))
  const [selectedDay, setSelectedDay] = useState(iso(today))
  const [modal, setModal] = useState<{open:boolean; request?:TransportRequest; slot?:number}>({open:false})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({data})=>setSession(data.session))
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event,s)=>setSession(s))
    return ()=>subscription.unsubscribe()
  },[])

  useEffect(() => {
    if (!session || !supabase) { setProfile(null); return }
    void loadProfile()
  },[session])

  async function loadProfile() {
    if (!supabase || !session) return
    const {data,error} = await supabase.from('profiles').select('*').eq('id',session.user.id).single()
    if (error) { setError('Не удалось загрузить профиль: '+error.message); return }
    if (!data.is_active) { await supabase.auth.signOut(); setError('Учётная запись заблокирована'); return }
    setProfile(data as Profile)
  }

  useEffect(() => {
    if (profile) void loadData()
  },[profile,month])

  async function loadData() {
    if (!supabase || !profile) return
    setLoading(true); setError('')
    const start = new Date(month.getFullYear(),month.getMonth(),1)
    const end = new Date(month.getFullYear(),month.getMonth()+1,0)
    const [u,r] = await Promise.all([
      supabase.from('business_units').select('*').eq('is_active',true).order('code'),
      supabase.from('transport_requests').select('*, profiles!transport_requests_requester_id_fkey(username), business_units!transport_requests_business_unit_id_fkey(code,name), request_cargo(cargo_type,stock_pallets,kdk_pallets,packaging_qty)')
        .gte('transport_date',iso(start)).lte('transport_date',iso(end)).order('slot_number')
    ])
    if (u.error) setError(u.error.message)
    else setUnits((u.data||[]) as BusinessUnit[])
    if (r.error) setError(r.error.message)
    else setRequests((r.data||[]) as TransportRequest[])
    setLoading(false)
  }

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setError('')
    // Supabase Auth uses a private synthetic email; users still enter only their anonymized username.
    const synthetic = `${login.trim().toLowerCase()}@login.akson-transport.invalid`
    const {error} = await supabase.auth.signInWithPassword({email:synthetic,password})
    if (error) setError('Не удалось войти. Проверьте логин и пароль.')
  }

  async function signOut() { await supabase?.auth.signOut(); setSession(null); setProfile(null) }

  const calendarDays = useMemo(() => {
    const first = new Date(month.getFullYear(),month.getMonth(),1)
    const mondayOffset = (first.getDay()+6)%7
    const start = new Date(first); start.setDate(first.getDate()-mondayOffset)
    return Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d})
  },[month])

  function canSeeAll() { return profile?.role !== 'customer' }
  function dayRequests(day:string) { return requests.filter(r=>r.transport_date===day && (canSeeAll() || r.requester_id===profile?.id)) }
  function slotLabel(r:TransportRequest) { return statusNames[r.status] || r.status }

  async function saveRequest(payload:any, existing?:TransportRequest) {
    if (!supabase || !profile) return
    setError('')
    const base = {
      requester_id: existing?.requester_id || profile.id,
      business_unit_id: existing?.business_unit_id || profile.business_unit_id,
      transport_date: payload.transport_date,
      slot_number: payload.slot_number,
      from_unit_id: payload.from_unit_id || null,
      from_other_address: payload.from_other_address || null,
      to_unit_id: payload.to_unit_id || null,
      to_other_address: payload.to_other_address || null,
      capacity_tons: Number(payload.capacity_tons),
      loading_type: payload.loading_type
    }
    let id = existing?.id
    if (existing) {
      const {error} = await supabase.from('transport_requests').update(base).eq('id',existing.id)
      if (error) throw error
    } else {
      const {data,error} = await supabase.from('transport_requests').insert(base).select('id').single()
      if (error) throw error
      id = data.id
    }
    if (!id) throw new Error('Не удалось определить заявку')
    await supabase.from('request_cargo').delete().eq('request_id',id)
    const cargo:CargoLine[] = payload.cargo_types.map((type:string)=>({
      cargo_type:type as any, stock_pallets:Number(payload.stock_pallets||0),
      kdk_pallets:Number(payload.kdk_pallets||0), packaging_qty:Number(payload.packaging_qty||0)
    }))
    const {error:cargoError} = await supabase.from('request_cargo').insert(cargo.map(c=>({...c,request_id:id})))
    if (cargoError) throw cargoError
    setModal({open:false}); await loadData()
  }

  async function changeStatus(r:TransportRequest,status:RequestStatus) {
    if (!supabase) return
    const {error} = await supabase.from('transport_requests').update({status}).eq('id',r.id)
    if (error) setError(error.message); else await loadData()
  }

  async function removeRequest(r:TransportRequest) {
    if (!supabase || !confirm('Удалить заявку?')) return
    const {error} = await supabase.from('transport_requests').update({status:'cancelled'}).eq('id',r.id)
    if (error) setError(error.message); else await loadData()
  }

  if (!supabaseConfigured) return <div className="setup"><img src="/apple-touch-icon.png"/><h1>Заказ транспорта БЕ → РЦ</h1><p>Для запуска добавьте параметры Supabase в файл <code>.env</code>.</p><p>См. README.md в архиве проекта.</p></div>
  if (!session || !profile) return <main className="login"><section className="login-card"><img src="/apple-touch-icon.png"/><h1>Заказ транспорта</h1><p>Вход по служебному логину</p><form onSubmit={signIn}><label>Логин<input value={login} onChange={e=>setLogin(e.target.value)} placeholder="USER-001" required autoComplete="username"/></label><label>Пароль<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required autoComplete="current-password"/></label><button className="primary">Войти</button></form>{error&&<p className="error">{error}</p>}</section></main>

  const monthRequests = requests.filter(r=>canSeeAll() || r.requester_id===profile.id)
  const chosen = dayRequests(selectedDay)
  const isAdmin = profile.role==='admin'
  const canManage = profile.role!=='customer'
  const monthStart = new Date(month.getFullYear(),month.getMonth(),1)
  const weekRows = Array.from({length:6},(_,i)=>i)

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><img src="/apple-touch-icon.png"/><div><b>Заказ транспорта</b><small>БЕ → РЦ</small></div></div><div className="top-actions"><span>{profile.username} · {roleNames[profile.role]}</span>{isAdmin&&<button className="icon-btn" title="Настройки"><Settings size={18}/></button>}<button className="icon-btn" onClick={signOut} title="Выйти"><LogOut size={18}/></button></div></header>
    <main className="content">
      <div className="page-heading"><div><h1>{canManage?'Рабочий календарь':'Календарь заявок'}</h1><p>{monthTitle(month)}</p></div><div className="month-nav"><button className="icon-btn" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))}><ChevronLeft/></button><button className="icon-btn" onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))}><ChevronRight/></button></div></div>
      {error&&<div className="error-banner">{error}</div>}
      <section className="calendar">
        <div className="weekdays">{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(x=><div key={x}>{x}</div>)}</div>
        {weekRows.map(w=><div className="week-row" key={w}><div className="week-number">{getWeekNumber(calendarDays[w*7])}</div>{calendarDays.slice(w*7,w*7+7).map(day=>{
          const key=dateKey(day), list=dayRequests(key), active=day.getMonth()===month.getMonth()
          return <div className={'day-cell '+(!active?'muted':'')+(selectedDay===key?' selected':'')} key={key} onClick={()=>setSelectedDay(key)}>
            <div className="day-number">{day.getDate()}</div><div className="slots">{[1,2,3].map(slot=>{
              const r=list.find(x=>x.slot_number===slot)
              if (!r) return <button key={slot} className="slot free" disabled={canManage} onClick={e=>{e.stopPropagation();setModal({open:true,slot})}}><Plus size={14}/></button>
              if (r.requester_id===profile.id) return <button key={slot} className={'slot mine '+r.status} onClick={e=>{e.stopPropagation();setModal({open:true,request:r})}}>{slotLabel(r)}</button>
              return <button key={slot} className="slot busy" disabled title="Занято">×</button>
            })}</div>
          </div>
        })}</div>)}
      </section>
      <section className="day-panel"><div className="panel-heading"><div><h2>Заявки за {new Date(selectedDay+'T00:00:00').toLocaleDateString('ru-RU')}</h2><small>{chosen.length} заявок</small></div><CalendarDays/></div>
        {chosen.length===0?<p className="empty">На выбранную дату заявок нет.</p>:chosen.map(r=><article className="request-card" key={r.id}>
          <div className="route"><b>{r.business_units?.code||'БЕ'} → {unitName(units,r.to_unit_id,r.to_other_address)}</b><span>{r.profiles?.username||profile.username}</span></div>
          <div className="request-meta"><span>{r.capacity_tons} т</span><span>{r.loading_type==='rear'?'Задняя':'Боковая'} погрузка</span><span>Слот {r.slot_number}</span><span className={'status '+r.status}>{statusNames[r.status]}</span></div>
          <div className="cargo-tags">{(r.request_cargo||[]).map((c,i)=><span key={i}>{c.cargo_type==='goods'?`Товар · Сток ${c.stock_pallets}, КДК ${c.kdk_pallets}`:c.cargo_type==='packaging'?`Тара · ${c.packaging_qty}`:'Оборудование'}</span>)}</div>
          {canManage&&<div className="card-actions"><select value={r.status} onChange={e=>changeStatus(r,e.target.value as RequestStatus)}><option value="created">Создан</option><option value="search">Поиск</option><option value="confirmed">Подтвержден</option><option value="completed">Выполнен</option><option value="cancelled">Отменён</option></select><button className="text-btn" onClick={()=>setModal({open:true,request:r})}><Pencil size={15}/> Изменить</button><button className="text-btn danger" onClick={()=>removeRequest(r)}><Trash2 size={15}/> Отменить</button></div>}
        </article>)}
      </section>
      {modal.open&&<RequestModal units={units} profile={profile} requests={requests} request={modal.request} slot={modal.slot} onClose={()=>setModal({open:false})} onSave={saveRequest}/>}
      {loading&&<div className="loading">Загрузка…</div>}
      <footer>Аксон Логистика · Заказ транспорта БЕ → РЦ</footer>
    </main>
  </div>
}

function unitName(units:BusinessUnit[],id:string|null,other:string|null) { return other || units.find(x=>x.id===id)?.code || 'Не указано' }
function getWeekNumber(d:Date) { const date=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); date.setUTCDate(date.getUTCDate()+4-(date.getUTCDay()||7)); const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1)); return Math.ceil((((date.getTime()-yearStart.getTime())/86400000)+1)/7) }

function RequestModal({units,profile,requests,request,slot,onClose,onSave}:{units:BusinessUnit[];profile:Profile;requests:TransportRequest[];request?:TransportRequest;slot?:number;onClose:()=>void;onSave:(p:any,r?:TransportRequest)=>Promise<void>}) {
  const [date,setDate]=useState(request?.transport_date||iso(today))
  const [slotNo,setSlotNo]=useState(request?.slot_number||slot||1)
  const [from,setFrom]=useState(request?.from_unit_id||profile.default_from_id||'')
  const [fromOther,setFromOther]=useState(request?.from_other_address||'')
  const [to,setTo]=useState(request?.to_unit_id||'')
  const [toOther,setToOther]=useState(request?.to_other_address||'')
  const [capacity,setCapacity]=useState(String(request?.capacity_tons||'5'))
  const [loadingType,setLoadingType]=useState<'rear'|'side'>(request?.loading_type||'rear')
  const [cargo,setCargo]=useState<string[]>(request?.request_cargo?.map(x=>x.cargo_type)||[])
  const [stock,setStock]=useState(String(request?.request_cargo?.find(x=>x.cargo_type==='goods')?.stock_pallets||0))
  const [kdk,setKdk]=useState(String(request?.request_cargo?.find(x=>x.cargo_type==='goods')?.kdk_pallets||0))
  const [packaging,setPackaging]=useState(String(request?.request_cargo?.find(x=>x.cargo_type==='packaging')?.packaging_qty||0))
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const be=units.filter(x=>x.kind==='BE'), rc=units.filter(x=>x.kind==='RC')
  const ownId=profile.id
  const occupied=requests.find(r=>r.transport_date===date&&r.slot_number===slotNo&&r.status!=='cancelled'&&r.id!==request?.id)
  function toggle(v:string) { setCargo(old=>old.includes(v)?old.filter(x=>x!==v):[...old,v]) }
  async function submit(e:React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('')
    try {
      if (!from || !to || (from==='other'&&!fromOther.trim()) || (to==='other'&&!toOther.trim())) throw new Error('Заполните маршрут.')
      if (!cargo.length) throw new Error('Выберите хотя бы один вид груза.')
      if (occupied) throw new Error('Этот слот уже занят. Выберите другой.')
      if (cargo.includes('goods') && Number(stock)+Number(kdk)<=0) throw new Error('Укажите количество Сток и/или КДК.')
      if (cargo.includes('packaging') && Number(packaging)<=0) throw new Error('Укажите количество тары.')
      await onSave({transport_date:date,slot_number:slotNo,from_unit_id:from==='other'?null:from,from_other_address:from==='other'?fromOther:null,to_unit_id:to==='other'?null:to,to_other_address:to==='other'?toOther:null,capacity_tons:capacity,loading_type:loadingType,cargo_types:cargo,stock_pallets:stock,kdk_pallets:kdk,packaging_qty:packaging},request)
    } catch(e:any) { setError(e.message||'Ошибка сохранения') } finally { setBusy(false) }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal" onSubmit={submit} onMouseDown={e=>e.stopPropagation()}><div className="modal-head"><div><h2>{request?'Заявка':'Новая заявка на транспорт'}</h2><small>{profile.username}</small></div><button type="button" className="icon-btn" onClick={onClose}><X/></button></div>
    <div className="form-grid"><label>Дата подачи<input type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label><label>Слот<select value={slotNo} onChange={e=>setSlotNo(Number(e.target.value))}>{[1,2,3].map(x=><option key={x} value={x}>Слот {x}</option>)}</select></label>
    <label>Откуда<select value={from} onChange={e=>setFrom(e.target.value)} required><option value="">Выберите БЕ</option>{be.map(x=><option value={x.id} key={x.id}>{x.code} — {x.name}</option>)}<option value="other">Другое</option></select></label>{from==='other'&&<label>Адрес отправления<input value={fromOther} onChange={e=>setFromOther(e.target.value)} required/></label>}
    <label>Куда<select value={to} onChange={e=>setTo(e.target.value)} required><option value="">Выберите РЦ / БЕ</option>{[...be,...rc].map(x=><option value={x.id} key={x.id}>{x.code} — {x.name}</option>)}<option value="other">Другое</option></select></label>{to==='other'&&<label>Адрес назначения<input value={toOther} onChange={e=>setToOther(e.target.value)} required/></label>}</div>
    <div className="form-section"><b>Грузоподъёмность</b><div className="choice-row">{['1.5','5','10','20'].map(x=><button type="button" className={capacity===x?'choice active':'choice'} onClick={()=>setCapacity(x)} key={x}>{x.replace('.',',')} т</button>)}</div></div>
    <div className="form-section"><b>Тип погрузки</b><div className="choice-row">{[['rear','Задняя'],['side','Боковая']].map(([v,n])=><button type="button" key={v} className={loadingType===v?'choice active':'choice'} onClick={()=>setLoadingType(v as any)}>{n}</button>)}</div></div>
    <div className="form-section"><b>Вид груза</b><div className="cargo-choice">
      <button type="button" className={cargo.includes('goods')?'cargo active':'cargo'} onClick={()=>toggle('goods')}><Package size={30}/><span>Товар</span></button>
      <button type="button" className={cargo.includes('equipment')?'cargo active':'cargo'} onClick={()=>toggle('equipment')}><Warehouse size={30}/><span>Оборудование</span></button>
      <button type="button" className={cargo.includes('packaging')?'cargo active':'cargo'} onClick={()=>toggle('packaging')}><PanelsTopLeft size={30}/><span>Тара</span></button>
    </div></div>
    {(cargo.includes('goods')||cargo.includes('packaging'))&&<div className="form-grid quantities">{cargo.includes('goods')&&<><label>Сток, паллетомест<input type="number" min="0" value={stock} onChange={e=>setStock(e.target.value)}/></label><label>КДК, паллетомест<input type="number" min="0" value={kdk} onChange={e=>setKdk(e.target.value)}/></label></>}{cargo.includes('packaging')&&<label>Количество тары<input type="number" min="1" value={packaging} onChange={e=>setPackaging(e.target.value)}/></label>}</div>}
    {error&&<p className="error">{error}</p>}<div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>Отмена</button><button className="primary" disabled={busy||!!occupied}>{busy?'Сохранение…':'Сохранить'}</button></div>
  </form></div>
}

export default App
