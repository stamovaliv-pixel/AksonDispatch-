export type Role = 'customer' | 'dispatcher' | 'utz' | 'admin'
export type RequestStatus = 'created' | 'search' | 'confirmed' | 'completed' | 'cancelled'
export type CargoType = 'goods' | 'equipment' | 'packaging'

export interface Profile {
  id: string
  username: string
  role: Role
  business_unit_id: string | null
  default_from_id: string | null
  is_active: boolean
}
export interface BusinessUnit {
  id: string
  code: string
  name: string
  kind: 'BE' | 'RC'
  address: string | null
  is_active: boolean
}
export interface CargoLine {
  cargo_type: CargoType
  stock_pallets: number
  kdk_pallets: number
  packaging_qty: number
}
export interface TransportRequest {
  id: string
  request_no: number
  requester_id: string
  business_unit_id: string
  transport_date: string
  slot_number: number
  from_unit_id: string | null
  from_other_address: string | null
  to_unit_id: string | null
  to_other_address: string | null
  capacity_tons: number
  loading_type: 'rear' | 'side'
  status: RequestStatus
  dispatcher_comment: string | null
  profiles?: { username: string } | null
  business_units?: { code: string; name: string } | null
  request_cargo?: CargoLine[]
}
