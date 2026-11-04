// =============================================================================
// Row types of the typed REST reads (FE-23)
// =============================================================================
// The billing, ticket and contract reads are typed in the OpenAPI spec from
// database/schema.sql (src/utils/tableRowSchema.js): DECIMAL columns are
// strings, dates are ISO strings, NULL-able columns may be null. Use these
// rather than a page-local interface that restates the columns.
// =============================================================================
import type { components } from './schema';

type Schemas = components['schemas'];

export type InvoiceRow = Schemas['Invoice'];
export type InvoiceItemRow = Schemas['InvoiceItem'];
export type PaymentRow = Schemas['Payment'];
export type PaymentAllocationRow = Schemas['PaymentAllocation'];
export type CreditNoteRow = Schemas['CreditNote'];
export type TicketRow = Schemas['Ticket'];
export type ContractRow = Schemas['Contract'];
