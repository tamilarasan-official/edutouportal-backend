/** Money formatting shared by emails and the API. */

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'en-IN', {
    style: 'currency',
    currency: currency || 'INR',
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount)
}

export interface Pricing {
  model: string
  amount: number | null
  currency: string
  note: string
  showCompareAt?: boolean
  compareAtAmount?: number | null
}

/** "Free", "₹99", "₹99 (was ₹199)", the note, or '' when the price is hidden. */
export function priceLabel(p: Pricing): string {
  if (p.model === 'free') return 'Free'
  if (p.model !== 'paid') return ''
  if (p.amount == null) return p.note || ''
  const now = formatMoney(p.amount, p.currency)
  return p.showCompareAt && p.compareAtAmount != null && p.compareAtAmount > p.amount
    ? `${now} (was ${formatMoney(p.compareAtAmount, p.currency)})`
    : now
}
