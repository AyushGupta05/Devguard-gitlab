import { requireRedisUrl } from "./cache.js";
import { formatInvoiceDate } from "./timezone.js";

export function sortInvoices(invoices) {
  return [...invoices].sort((left, right) => {
    return left.issuedAt.localeCompare(right.issuedAt);
  });
}

export function buildInvoiceSummary(invoices) {
  const redisUrl = requireRedisUrl();
  const orderedInvoices = sortInvoices(invoices);

  return orderedInvoices.map((invoice) => ({
    id: invoice.id,
    issuedAt: formatInvoiceDate(new Date(invoice.issuedAt)),
    cacheTarget: redisUrl
  }));
}
