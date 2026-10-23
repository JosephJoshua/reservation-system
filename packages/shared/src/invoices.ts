/** Whom an invoice is made out to: the student personally, or a company with a tax number. */
export type InvoiceTitleKind = 'personal' | 'company'

export interface InvoiceTitle {
  kind: InvoiceTitleKind
  /** The person's or the company's name. */
  name: string
  /** 纳税人识别号, for a company. Empty for a person. */
  taxNumber: string
  /** Where the tax system sends the invoice. */
  email: string
}

export type InvoiceStatus = 'requested' | 'issued' | 'rejected'

export const invoiceStatusLabels: Record<InvoiceStatus, string> = {
  requested: '开票中',
  issued: '已开票',
  rejected: '未通过',
}

export const invoiceTitleKindLabels: Record<InvoiceTitleKind, string> = {
  personal: '个人',
  company: '单位',
}

/**
 * Where a paid order stands for invoicing: `available` and `rejected` can be requested (again),
 * `refunding` waits for a refund to finish, and a fully `refunded` order cannot be invoiced.
 */
export type InvoiceState =
  | 'available'
  | 'requested'
  | 'issued'
  | 'rejected'
  | 'refunding'
  | 'refunded'

export interface OrderInvoiceDto {
  orderId: number
  state: InvoiceState
  /** The latest request, when there is one. */
  invoiceId: number | null
  /** What an invoice would be for: the amount paid less what was refunded. */
  amount: number
  rejectReason: string | null
}

export interface InvoiceOrderDto extends OrderInvoiceDto {
  /** What was bought, such as the lesson or package name. */
  description: string
  kind: 'class' | 'trial' | 'package'
  paidAt: string
}

export interface StudentInvoicesDto {
  orders: InvoiceOrderDto[]
  /** The title used last, to fill the form. */
  lastTitle: InvoiceTitle | null
}

export interface AdminInvoiceDto {
  id: number
  status: InvoiceStatus
  title: InvoiceTitle
  amount: number
  createdAt: string
  issuedAt: string | null
  rejectReason: string | null
  hasPdf: boolean
  order: {
    id: number
    description: string
    kind: 'class' | 'trial' | 'package'
    amount: number
    provider: 'wechat' | 'offline'
    paidAt: string | null
    refunded: number
  }
  /** A refund on the order since the request that staff have not looked at yet. */
  refundFlag: boolean
  student: { id: number; name: string; phone: string }
}

const TAX_NUMBER = /^[0-9A-Z]{15}$|^[0-9A-Z]{17,18}$|^[0-9A-Z]{20}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Tidies what the student typed: trims, and upper-cases the tax number. */
export function normalizeInvoiceTitle(t: InvoiceTitle): InvoiceTitle {
  return {
    kind: t.kind,
    name: t.name.trim(),
    taxNumber: t.kind === 'company' ? t.taxNumber.trim().toUpperCase() : '',
    email: t.email.trim(),
  }
}

/** The first problem with a title, as the message to show, or null when it is fine. */
export function invoiceTitleError(t: InvoiceTitle): string | null {
  const n = normalizeInvoiceTitle(t)
  if (!n.name) return n.kind === 'company' ? '请填写单位名称' : '请填写抬头'
  if (n.name.length > 50) return '抬头不能超过 50 个字'
  if (n.kind === 'company' && !TAX_NUMBER.test(n.taxNumber)) return '请填写正确的税号'
  if (!EMAIL.test(n.email) || n.email.length > 100) return '请填写正确的邮箱'
  return null
}
