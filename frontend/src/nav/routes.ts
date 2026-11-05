// =============================================================================
// VigaBSS 5.0 — Navigation route registry ("Faro" nav)
// =============================================================================
// Single source of truth for where every routed page lives in the UI.
// Three consumers derive from this registry:
//   1. The sidebar rail (Layout.tsx → NavSection) — items with `rail: true`
//   2. The hub pages (/billing, /network, /admin → HubPage) — items with `card`
//   3. (PR-3) the command palette
//
// Invariants — enforced by src/test/navRegistry.test.ts:
//   • Every path routed in App.tsx appears exactly once here (hubs aside).
//   • Every entry is reachable: rail row and/or hub card.
//   • `guard` mirrors the PrivateRoute wrapper the path is declared under in
//     App.tsx — a row whose guard the user fails would render <NotAllowed/>,
//     so canSee() hides it.
//
// Visibility model — canSee():
//   • With the resolved permissions /auth/me returns, a row is visible when
//     they include one of its `viewPermissions` (the backend permission of the
//     page's list request), so custom groups and grants to built-in groups
//     show exactly what the backend allows (FE-25). PrivateRoute opens pages
//     by the same rule. The rules below are the fallback without permissions.
//   • `roles` is an explicit allowlist (set membership, NOT rank compare), so
//     the technician=billing rank tie in hasRole() is never consulted for nav.
//   • Legacy `admin` sees everything; `readonly` sees everything its route
//     guards allow except pages that explicitly require a resolved permission.
//   • Allowlists were audited against backend requirePermission slugs and
//     role_permissions seeds (migrations 119/194/197/199/298/365/377) so that
//     no visible row 403s — see PR description for the audit table.
// =============================================================================

import { hasRole } from '@/auth/roles';

export type Role = 'admin' | 'billing' | 'support' | 'technician' | 'readonly';

/** PrivateRoute wrapper tier in App.tsx that serves this path. */
export type Guard = 'any' | 'technician' | 'billing' | 'admin';

export type SectionId =
  | 'dashboard'
  | 'clients'
  | 'billing'
  | 'support'
  | 'fieldops'
  | 'network'
  | 'inventory'
  | 'compliance'
  | 'admin';

export interface RouteDef {
  /** Absolute path as routed in App.tsx. */
  path: string;
  /** i18n key for the label (reused by rail, hub cards and palette). */
  labelKey: string;
  section: SectionId;
  /** Must mirror the App.tsx PrivateRoute wrapper — tested. */
  guard: Guard;
  /** Rail subheading id (nav.subsections.<sub>); rail items only. */
  sub?: string;
  /** Hub card id (nav.cards.<card>); hub sections only. */
  card?: string;
  /** True = always-visible sidebar row. Card-only items live on the hub page. */
  rail?: boolean;
  /** Explicit allowlist. Omitted = any authenticated role (guard still applies). */
  roles?: Role[];
  /**
   * Permissions that open this page: the backend permission of its list
   * request (any one of its tabs' for a tabbed page). When the session has
   * resolved permissions they decide, instead of `guard` and `roles` (FE-25).
   */
  viewPermissions?: string[];
  /** At least one resolved backend permission is required for sensitive pages. */
  requiredAnyPermissions?: string[];
  /** Only shown when the active org's compliance locale matches. */
  requiredLocale?: 'MX';
  /** Install-wide infrastructure that tenant admins must not see or open. */
  installOperatorOnly?: boolean;
  /**
   * Extra command-palette search terms (untranslated: domain jargon and
   * Spanish synonyms operators actually type — "iva", "corte", "timbrado").
   */
  keywords?: string[];
}

export interface SectionDef {
  id: SectionId;
  labelKey: string;
  kind: 'link' | 'group' | 'hub';
  /** Direct target for kind 'link'. */
  path?: string;
  /** Overview page for kind 'hub' (also the "View all N →" target). */
  hubPath?: string;
  /** Guard of the hub route itself — gates the header link + View-all row. */
  hubGuard?: Guard;
  hubRoles?: Role[];
}

export const SECTIONS: SectionDef[] = [
  { id: 'dashboard', labelKey: 'nav.dashboard', kind: 'link', path: '/' },
  { id: 'clients', labelKey: 'nav.sections.clients', kind: 'group' },
  { id: 'billing', labelKey: 'nav.sections.billing', kind: 'hub', hubPath: '/billing', hubGuard: 'billing', hubRoles: ['billing'] },
  { id: 'support', labelKey: 'nav.sections.support', kind: 'group' },
  { id: 'fieldops', labelKey: 'nav.sections.fieldWork', kind: 'group' },
  { id: 'network', labelKey: 'nav.sections.network', kind: 'hub', hubPath: '/network', hubGuard: 'technician', hubRoles: ['technician'] },
  { id: 'inventory', labelKey: 'nav.sections.inventory', kind: 'group' },
  { id: 'compliance', labelKey: 'nav.sections.compliance', kind: 'group' },
  { id: 'admin', labelKey: 'nav.sections.admin', kind: 'hub', hubPath: '/admin', hubGuard: 'admin' },
];

/**
 * Navigation-focus presets — an admin/readonly convenience that puts one job's
 * sections first without touching permissions or removing any authorized
 * section ("admin, but doing billing today"). 'full' keeps canonical order.
 */
export interface WorkspaceDef {
  id: string;
  labelKey: string;
  /** Sections promoted ahead of the remaining authorized areas. */
  sections?: SectionId[];
}

export const WORKSPACES: WorkspaceDef[] = [
  { id: 'full', labelKey: 'nav.workspaces.full' },
  { id: 'billing', labelKey: 'nav.workspaces.billing', sections: ['clients', 'billing', 'support', 'compliance'] },
  { id: 'field', labelKey: 'nav.workspaces.field', sections: ['clients', 'support', 'fieldops', 'network', 'inventory'] },
  { id: 'support', labelKey: 'nav.workspaces.support', sections: ['clients', 'support', 'network'] },
  { id: 'noc', labelKey: 'nav.workspaces.noc', sections: ['network', 'fieldops'] },
];

/** Hub card ordering per hub section (card id → nav.cards.<id>). */
export const HUB_CARDS: Record<string, string[]> = {
  billing: ['receivables', 'collections', 'processing', 'catalogPricing', 'reportsAnalytics', 'configuration'],
  network: ['monitoringNoc', 'radiusAaa', 'ipam', 'devicesConfig', 'pollingAlerting', 'ftthPon', 'cpe', 'wirelessQos', 'accessProvisioning'],
  admin: ['peopleAccess', 'organization', 'automationIntegrations', 'ai', 'governance'],
};

export const ROUTES: RouteDef[] = [
  // --- Clients ---------------------------------------------------------------
  { path: '/clients', labelKey: 'nav.clients', section: 'clients', guard: 'any', sub: 'directory', rail: true, viewPermissions: ['clients.view'] },
  { path: '/client-groups', labelKey: 'nav.clientGroups', section: 'clients', guard: 'any', sub: 'directory', rail: true, viewPermissions: ['clients.view'] },
  // technician lacks leads.view / surveys.view / tickets.view (mig 194/197/119) — audited
  { path: '/leads', labelKey: 'nav.leads', section: 'clients', guard: 'any', sub: 'sales', rail: true, roles: ['support', 'billing'], viewPermissions: ['leads.view'] },
  { path: '/quotes', labelKey: 'nav.quotes', section: 'clients', guard: 'billing', sub: 'sales', rail: true, roles: ['billing'], viewPermissions: ['quotes.view'] },
  { path: '/service-orders', labelKey: 'nav.serviceOrders', section: 'clients', guard: 'any', sub: 'sales', rail: true, viewPermissions: ['service_orders.view'] },
  { path: '/contracts', labelKey: 'nav.contracts', section: 'clients', guard: 'any', sub: 'sales', rail: true, viewPermissions: ['contracts.view'] },
  { path: '/promotions', labelKey: 'nav.promotions', section: 'clients', guard: 'billing', sub: 'retention', rail: true, roles: ['billing'], viewPermissions: ['promotions.view'] },
  { path: '/winback-campaigns', labelKey: 'nav.winbackCampaigns', section: 'clients', guard: 'billing', sub: 'retention', rail: true, roles: ['billing'], viewPermissions: ['winback.view'] },
  { path: '/churn-analytics', labelKey: 'nav.churnAnalytics', section: 'clients', guard: 'billing', sub: 'retention', rail: true, roles: ['billing'], viewPermissions: ['lifecycle.view'] },

  // --- Billing (hub: /billing) ------------------------------------------------
  { path: '/invoices', keywords: ['facturas', 'cobro'], labelKey: 'nav.invoices', section: 'billing', guard: 'any', sub: 'receivables', card: 'receivables', rail: true, roles: ['billing'], viewPermissions: ['invoices.view'] },
  { path: '/payments', keywords: ['pagos', 'abonos'], labelKey: 'nav.payments', section: 'billing', guard: 'any', sub: 'receivables', card: 'receivables', rail: true, roles: ['billing'], viewPermissions: ['payments.view'] },
  { path: '/cfdi', keywords: ['sat', 'timbrado', 'stamp', 'factura'], labelKey: 'nav.cfdi', section: 'billing', guard: 'billing', sub: 'receivables', card: 'receivables', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['cfdi_documents.view'] },
  { path: '/credit-notes', labelKey: 'nav.creditNotes', section: 'billing', guard: 'billing', sub: 'receivables', card: 'receivables', rail: true, roles: ['billing'], viewPermissions: ['credit_notes.view'] },
  { path: '/cash-reconciliation', keywords: ['corte', 'caja'], labelKey: 'nav.cashReconciliation', section: 'billing', guard: 'billing', sub: 'receivables', card: 'receivables', rail: true, roles: ['billing'], viewPermissions: ['cash_reconciliation.view'] },
  { path: '/plans', labelKey: 'nav.plans', section: 'billing', guard: 'billing', sub: 'catalog', card: 'catalogPricing', rail: true, roles: ['billing'], viewPermissions: ['plans.view'] },
  { path: '/billing-disputes', labelKey: 'nav.billingDisputes', section: 'billing', guard: 'billing', sub: 'catalog', card: 'collections', rail: true, roles: ['billing'], viewPermissions: ['billing_disputes.view'] },
  { path: '/reports', labelKey: 'nav.reports', section: 'billing', guard: 'billing', sub: 'catalog', card: 'reportsAnalytics', rail: true, roles: ['billing'], viewPermissions: ['invoices.view', 'clients.view', 'ift_statistical_reports.view'] },
  { path: '/billing-adjustments', labelKey: 'nav.billingAdjustments', section: 'billing', guard: 'billing', card: 'receivables', roles: ['billing'], viewPermissions: ['billing_adjustments.view'] },
  { path: '/expenses', labelKey: 'nav.expenses', section: 'billing', guard: 'billing', card: 'receivables', roles: ['billing'], viewPermissions: ['expenses.view'] },
  { path: '/payment-plans', keywords: ['morosos', 'convenio'], labelKey: 'nav.paymentPlans', section: 'billing', guard: 'billing', card: 'collections', roles: ['billing'], viewPermissions: ['payment_plans.view'] },
  { path: '/refund-requests', labelKey: 'nav.refundRequests', section: 'billing', guard: 'billing', card: 'collections', roles: ['billing'], viewPermissions: ['refund_requests.view'] },
  { path: '/chargebacks', labelKey: 'nav.chargebacks', section: 'billing', guard: 'billing', card: 'collections', roles: ['billing'], viewPermissions: ['chargebacks.view'] },
  { path: '/payment-gateways', labelKey: 'nav.paymentGateways', section: 'billing', guard: 'billing', card: 'processing', roles: ['billing'], viewPermissions: ['payment_gateways.view'] },
  { path: '/payment-problems', keywords: ['webhooks', 'conciliacion', 'pagos', 'reembolsos', 'rep'], labelKey: 'nav.paymentProblems', section: 'billing', guard: 'billing', card: 'processing', roles: ['billing'], viewPermissions: ['payment_gateways.view'] },
  { path: '/payment-transactions', labelKey: 'nav.paymentTransactions', section: 'billing', guard: 'billing', card: 'processing', roles: ['billing'], viewPermissions: ['payment_transactions.view'] },
  { path: '/recurring-payment-profiles', labelKey: 'nav.recurringPaymentProfiles', section: 'billing', guard: 'billing', card: 'processing', roles: ['billing'], viewPermissions: ['recurring_payment_profiles.view'] },
  { path: '/tax-reports', keywords: ['iva', 'impuestos', 'fiscal'], labelKey: 'nav.taxReports', section: 'billing', guard: 'billing', card: 'reportsAnalytics', roles: ['billing'], viewPermissions: ['billing.tax_reports'] },
  { path: '/analytics-dashboard', labelKey: 'nav.analyticsDashboard', section: 'billing', guard: 'billing', card: 'reportsAnalytics', roles: ['billing'], viewPermissions: ['invoices.view', 'clients.view', 'reports.view'] },
  { path: '/tax-rules', keywords: ['iva', 'impuestos'], labelKey: 'nav.taxRules', section: 'billing', guard: 'billing', card: 'configuration', roles: ['billing'], viewPermissions: ['tax_rules.view'] },
  { path: '/tax-rates', keywords: ['iva', 'impuestos'], labelKey: 'nav.taxRates', section: 'billing', guard: 'billing', card: 'configuration', roles: ['billing'], viewPermissions: ['tax_rates.view'] },
  { path: '/invoice-settings', labelKey: 'nav.invoiceSettings', section: 'billing', guard: 'billing', card: 'configuration', roles: ['billing'], viewPermissions: ['invoice_settings.view'] },
  // Day-one migration off the previous billing system. Billing rather than
  // Administration because the backend guards each importer on the ENTITY's own
  // create permission (invoices.create, payments.create, ...), not on an admin
  // slug — a nav home implying admin-only would misdescribe who can use it.
  { path: '/data-import', keywords: ['csv', 'importar', 'migracion', 'migration'], labelKey: 'nav.dataImport', section: 'billing', guard: 'billing', card: 'configuration', roles: ['billing'], viewPermissions: ['clients.create', 'devices.create', 'contracts.create', 'invoices.create'] },
  { path: '/late-fee-rules', keywords: ['mora', 'morosos', 'recargos'], labelKey: 'nav.lateFeeRules', section: 'billing', guard: 'billing', card: 'configuration', roles: ['billing'], viewPermissions: ['late_fees.view'] },
  { path: '/payment-reminder-settings', labelKey: 'nav.paymentReminderSettings', section: 'billing', guard: 'billing', card: 'configuration', roles: ['billing'], viewPermissions: ['payment_reminders.view'] },

  // --- Support -----------------------------------------------------------------
  // tickets.view: support (119) + technician (394; sees all categories except
  // billing — tickets.view_billing gates those). Billing still lacks tickets.view.
  { path: '/tickets', keywords: ['soporte', 'casos'], labelKey: 'nav.tickets', section: 'support', guard: 'any', rail: true, roles: ['support', 'technician'], viewPermissions: ['tickets.view'] },
  // escalations.view: technician+support (197) + billing (394)
  { path: '/escalations', labelKey: 'nav.escalations', section: 'support', guard: 'any', rail: true, roles: ['technician', 'support', 'billing'], viewPermissions: ['escalations.view'] },
  { path: '/self-service-requests', keywords: ['solicitudes', 'portal', 'autoservicio'], labelKey: 'nav.portalServiceRequests', section: 'support', guard: 'any', rail: true, roles: ['technician'], viewPermissions: ['portal_service_requests.view'] },
  { path: '/follow-up-reminders', labelKey: 'nav.followUps', section: 'support', guard: 'any', rail: true, roles: ['technician', 'support', 'billing'], viewPermissions: ['follow_ups.view'] },
  { path: '/communication-campaigns', labelKey: 'nav.communicationCampaigns', section: 'support', guard: 'any', rail: true, roles: ['technician', 'support', 'billing'], viewPermissions: ['campaigns.view'] },
  // message_outbox.view: admin, support, billing, noc_operator, auditor (511)
  { path: '/message-outbox', keywords: ['correo', 'envios', 'mensajes', 'rebotes'], labelKey: 'nav.messageOutbox', section: 'support', guard: 'any', rail: true, roles: ['support', 'billing'], viewPermissions: ['message_outbox.view'] },
  { path: '/satisfaction-surveys', labelKey: 'nav.surveys', section: 'support', guard: 'any', rail: true, roles: ['support', 'billing'], viewPermissions: ['surveys.view'] },

  // --- Field Ops -----------------------------------------------------------------
  { path: '/work-orders', keywords: ['visita', 'instalacion'], labelKey: 'nav.workOrders', section: 'fieldops', guard: 'technician', rail: true, roles: ['technician'], viewPermissions: ['work_orders.view'] },
  { path: '/maintenance-windows', labelKey: 'nav.maintenanceWindows', section: 'fieldops', guard: 'technician', rail: true, roles: ['technician'], viewPermissions: ['maintenance_windows.view'] },
  { path: '/sites', labelKey: 'nav.sites', section: 'fieldops', guard: 'technician', rail: true, roles: ['technician'], viewPermissions: ['sites.view'] },
  { path: '/coverage-zones', labelKey: 'nav.coverageZones', section: 'fieldops', guard: 'technician', rail: true, roles: ['technician'], viewPermissions: ['coverage_zones.view'] },
  { path: '/service-areas', labelKey: 'nav.serviceAreas', section: 'fieldops', guard: 'technician', rail: true, roles: ['technician'], viewPermissions: ['service_areas.view'] },

  // --- Network (hub: /network) ---------------------------------------------------
  // noc.view: admin/support/readonly (298) + technician (394); support/readonly
  // still fail the technician route guard
  { path: '/noc-dashboard', labelKey: 'nav.nocDashboard', section: 'network', guard: 'technician', card: 'monitoringNoc', rail: true, roles: ['technician'], viewPermissions: ['noc.view'] },
  // support lacks devices.view (deliberately — see mig 383 notes) — audited
  { path: '/devices', labelKey: 'nav.devices', section: 'network', guard: 'any', card: 'monitoringNoc', rail: true, roles: ['technician'], viewPermissions: ['devices.view'] },
  // any-auth guard + support in the allowlist: support has network_health.view /
  // outages.view via mig 377 — the "is it down?" subset
  { path: '/network-health', labelKey: 'nav.networkHealth', section: 'network', guard: 'any', card: 'monitoringNoc', rail: true, roles: ['technician', 'support'], viewPermissions: ['network_health.view'] },
  { path: '/outages', keywords: ['down', 'caida', 'fuera de servicio'], labelKey: 'nav.outages', section: 'network', guard: 'any', card: 'monitoringNoc', rail: true, roles: ['technician', 'support'], viewPermissions: ['outages.view'] },
  { path: '/radius-sessions', keywords: ['pppoe', 'sesiones', 'online'], labelKey: 'nav.radiusSessions', section: 'network', guard: 'technician', card: 'radiusAaa', rail: true, roles: ['technician'], viewPermissions: ['connection_logs.view', 'connection_logs.summary'] },
  { path: '/nas', keywords: ['mikrotik', 'router', 'bras'], labelKey: 'nav.nas', section: 'network', guard: 'technician', card: 'devicesConfig', rail: true, roles: ['technician'], viewPermissions: ['devices.view'] },
  { path: '/ip-pools', labelKey: 'nav.ipPools', section: 'network', guard: 'technician', card: 'ipam', rail: true, roles: ['technician'], viewPermissions: ['ip_pools.view'] },
  // carries a card so the hub shows it and "View all N" counts stay honest
  { path: '/wg-tunnels', keywords: ['wireguard', 'vpn'], labelKey: 'nav.myWgTunnels', section: 'network', guard: 'any', card: 'accessProvisioning', rail: true, viewPermissions: ['wireguard.peers.view'] },
  { path: '/speed-tests', labelKey: 'nav.speedTests', section: 'network', guard: 'technician', card: 'monitoringNoc', roles: ['technician'], viewPermissions: ['speed_tests.view'] },
  { path: '/connection-logs', labelKey: 'nav.connectionLogs', section: 'network', guard: 'any', card: 'monitoringNoc', rail: true, roles: ['technician', 'support'], viewPermissions: ['connection_logs.view'] },
  { path: '/topology-map', labelKey: 'nav.topologyMap', section: 'network', guard: 'technician', card: 'monitoringNoc', roles: ['technician'], viewPermissions: ['topology.view', 'mapping.customer_locations', 'mapping.infrastructure', 'mapping.fiber_routes'] },
  { path: '/snmp-metrics', labelKey: 'nav.snmpMetrics', section: 'network', guard: 'technician', card: 'monitoringNoc', roles: ['technician'], viewPermissions: ['devices.view'] },
  { path: '/snmp-traps', labelKey: 'nav.snmpTraps', section: 'network', guard: 'technician', card: 'monitoringNoc', roles: ['technician'], viewPermissions: ['devices.view'] },
  { path: '/session-accounting', labelKey: 'nav.sessionAccounting', section: 'network', guard: 'technician', card: 'radiusAaa', roles: ['technician'], viewPermissions: ['connection_logs.view'] },
  { path: '/subscriber-certificates', labelKey: 'nav.subscriberCertificates', section: 'network', guard: 'technician', card: 'radiusAaa', roles: ['technician'], viewPermissions: ['subscriber_certificates.view'] },
  { path: '/mac-move-events', labelKey: 'nav.macMoveEvents', section: 'network', guard: 'technician', card: 'radiusAaa', roles: ['technician'], viewPermissions: ['radius.mac_move_events.view'] },
  { path: '/pppoe-service-profiles', labelKey: 'nav.pppoeServiceProfiles', section: 'network', guard: 'technician', card: 'radiusAaa', roles: ['technician'], viewPermissions: ['pppoe_service_profiles.view'] },
  { path: '/pppoe-diagnostics', labelKey: 'nav.pppoeDiagnostics', section: 'network', guard: 'any', card: 'radiusAaa', rail: true, roles: ['technician', 'support', 'readonly'], viewPermissions: ['pppoe.diagnostics'] },
  { path: '/ip-assignments', labelKey: 'nav.ipAssignments', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['ip_assignments.view'] },
  { path: '/vlans', labelKey: 'nav.vlans', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['vlans.view'] },
  { path: '/dhcp-servers', labelKey: 'nav.dhcpServers', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['dhcp_servers.view'] },
  { path: '/nat-management', labelKey: 'nav.natManagement', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['nat_pools.view'] },
  { path: '/ptr-records', labelKey: 'nav.ptrRecords', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['ptr_records.view'] },
  { path: '/ipv6-management', labelKey: 'nav.ipv6Management', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['ra_guard.view', 'ipv6.management'] },
  { path: '/transition-mechanisms', labelKey: 'nav.transitionMechanisms', section: 'network', guard: 'technician', card: 'ipam', roles: ['technician'], viewPermissions: ['transition_mechanisms.view'] },
  { path: '/device-groups', labelKey: 'nav.deviceGroups', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['device_groups.view'] },
  { path: '/discovery-scans', labelKey: 'nav.discoveryScans', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['discovery_scans.view'] },
  { path: '/device-import', labelKey: 'nav.deviceImport', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['devices.create'] },
  { path: '/snmp-profiles', labelKey: 'nav.snmpProfiles', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['snmp_profiles.view'] },
  { path: '/device-config-backups', labelKey: 'nav.deviceConfigBackups', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['device_config_backups.view'] },
  { path: '/config-templates', labelKey: 'nav.configTemplates', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['config_templates.view'] },
  { path: '/config-backup-schedules', labelKey: 'nav.configBackupSchedules', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['config_backup_schedules.view'] },
  { path: '/config-compliance-rules', labelKey: 'nav.configComplianceRules', section: 'network', guard: 'technician', card: 'devicesConfig', roles: ['technician'], viewPermissions: ['config_compliance.view'] },
  { path: '/poller-nodes', labelKey: 'nav.pollerNodes', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['poller_nodes.view'] },
  { path: '/device-polling-configs', labelKey: 'nav.devicePollingConfigs', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['polling_configs.view'] },
  { path: '/poller-performance', labelKey: 'nav.pollerPerformance', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['poller_performance.view'] },
  { path: '/trap-forwarding-rules', labelKey: 'nav.trapForwardingRules', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['trap_forwarding.view'] },
  { path: '/alert-channels', labelKey: 'nav.alertChannels', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['alert_channels.view'] },
  { path: '/alert-escalation-chains', labelKey: 'nav.alertEscalationChains', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['alert_escalations.view'] },
  { path: '/alert-suppression-rules', labelKey: 'nav.alertSuppressionRules', section: 'network', guard: 'technician', card: 'pollingAlerting', roles: ['technician'], viewPermissions: ['alert_suppression.view'] },
  { path: '/olt-management', labelKey: 'nav.oltManagement', section: 'network', guard: 'technician', card: 'ftthPon', roles: ['technician'], viewPermissions: ['olt_ports.view', 'olt_splitters.view'] },
  { path: '/onu-management', keywords: ['ftth', 'fibra', 'provision'], labelKey: 'nav.onuManagement', section: 'network', guard: 'technician', card: 'ftthPon', roles: ['technician'], viewPermissions: ['onu_management.view', 'onu_profiles.view', 'onu_whitelist.view'] },
  { path: '/pon-port-management', labelKey: 'nav.ponPortManagement', section: 'network', guard: 'technician', card: 'ftthPon', roles: ['technician'], viewPermissions: ['olt_ports.utilization', 'onu_migration_jobs.view'] },
  { path: '/fiber-plant-management', labelKey: 'nav.fiberPlantManagement', section: 'network', guard: 'technician', card: 'ftthPon', roles: ['technician'], viewPermissions: ['fiber_routes.view', 'odf_frames.view', 'otdr_tests.view'] },
  { path: '/cpe-management', labelKey: 'nav.cpeManagement', section: 'network', guard: 'technician', card: 'cpe', roles: ['technician'], viewPermissions: ['cpe_devices.view', 'cpe_firmware_versions.view', 'cpe_firmware_campaigns.view'] },
  // cpe_profiles.view is admin-only (mig 276; 391's CPE grants to technician
  // cover devices/inventory/lifecycle, not profiles)
  { path: '/cpe-profiles', labelKey: 'nav.cpeProfiles', section: 'network', guard: 'technician', card: 'cpe', roles: ['admin'], viewPermissions: ['cpe_profiles.view'] },
  { path: '/cpe-diagnostics', labelKey: 'nav.cpeDiagnostics', section: 'network', guard: 'technician', card: 'cpe', roles: ['technician'], viewPermissions: ['cpe_devices.view', 'cpe_diagnostics.view', 'cpe_session_logs.view'] },
  { path: '/wireless', labelKey: 'nav.wireless', section: 'network', guard: 'technician', card: 'wirelessQos', roles: ['technician'], viewPermissions: ['ap_sectors.view', 'wireless_clients.view'] },
  { path: '/wireless-metrics', labelKey: 'nav.wirelessMetrics', section: 'network', guard: 'technician', card: 'wirelessQos', roles: ['technician'], viewPermissions: ['rf_metrics.view', 'link_planning.view'] },
  { path: '/qos-bandwidth', labelKey: 'nav.qosBandwidth', section: 'network', guard: 'technician', card: 'wirelessQos', roles: ['technician'], viewPermissions: ['quality_classes.view', 'queue_tree_nodes.view', 'rate_limit_templates.view'] },
  { path: '/suspension-rules', labelKey: 'nav.suspensionRules', section: 'network', guard: 'technician', card: 'accessProvisioning', roles: ['technician'], viewPermissions: ['suspension_rules.view'] },
  // The OPERATIONS side of the same feature: preview who a rule would hit, run
  // it on demand, and see what it did. Sits beside the rule authoring page.
  // roles mirrors suspension-rules exactly — evaluate needs contracts.view,
  // which technician holds; the run button is separately gated on
  // contracts.update inside the page.
  { path: '/suspension-console', keywords: ['suspension', 'corte', 'suspender', 'reconectar'], labelKey: 'nav.suspensionConsole', section: 'network', guard: 'technician', card: 'accessProvisioning', roles: ['technician'], viewPermissions: ['contracts.view'] },
  // Both halves of GPS tracking: dispatch sees positions, the technician posts
  // them from browser geolocation. technician holds BOTH .view and .ingest
  // (migration 298); support holds .view only, so the share button is gated
  // separately inside the page.
  { path: '/technician-map', keywords: ['gps', 'mapa', 'tecnicos', 'ubicacion', 'dispatch'], labelKey: 'nav.technicianMap', section: 'network', guard: 'technician', card: 'monitoringNoc', roles: ['technician'], viewPermissions: ['technician_tracking.view'] },

  // --- Inventory ---------------------------------------------------------------
  { path: '/inventory', labelKey: 'nav.inventory', section: 'inventory', guard: 'technician', sub: 'stock', rail: true, roles: ['technician'], viewPermissions: ['inventory.view'] },
  { path: '/inventory-management', labelKey: 'nav.inventoryManagement', section: 'inventory', guard: 'technician', sub: 'stock', rail: true, roles: ['technician'], viewPermissions: ['inventory.view', 'assets.view', 'vendors.view', 'purchase_orders.view'] },
  { path: '/warehouses', labelKey: 'nav.warehouses', section: 'inventory', guard: 'technician', sub: 'stock', rail: true, roles: ['technician'], viewPermissions: ['inventory.view'] },
  { path: '/cpe-inventory', labelKey: 'nav.cpeInventory', section: 'inventory', guard: 'technician', sub: 'stock', rail: true, roles: ['technician'], viewPermissions: ['cpe_devices.view', 'cpe_lifecycle_history.view', 'cpe_inventory.view'] },
  { path: '/vendors', labelKey: 'nav.vendors', section: 'inventory', guard: 'technician', sub: 'purchasing', rail: true, roles: ['technician'], viewPermissions: ['vendors.view'] },
  { path: '/purchase-orders', labelKey: 'nav.purchaseOrders', section: 'inventory', guard: 'technician', sub: 'purchasing', rail: true, roles: ['technician'], viewPermissions: ['purchase_orders.view'] },

  // --- Compliance -----------------------------------------------------------------
  { path: '/csd-certificates', labelKey: 'nav.csdCertificates', section: 'compliance', guard: 'billing', sub: 'cfdiSat', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['csd_certificates.view'] },
  { path: '/pac-providers', labelKey: 'nav.pacProviders', section: 'compliance', guard: 'billing', sub: 'cfdiSat', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['pac_providers.view'] },
  { path: '/sat-catalogs', labelKey: 'nav.satCatalogs', section: 'compliance', guard: 'billing', sub: 'cfdiSat', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['cfdi_documents.view'] },
  { path: '/facturas-publicas', labelKey: 'nav.facturasPublicas', section: 'compliance', guard: 'billing', sub: 'cfdiSat', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['facturas_publicas.view'] },
  { path: '/regulatory-filings', labelKey: 'nav.regulatoryFilings', section: 'compliance', guard: 'billing', sub: 'ift', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['regulatory_filings.view'] },
  { path: '/concession-titles', labelKey: 'nav.concessionTitles', section: 'compliance', guard: 'billing', sub: 'ift', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['concession_titles.view'] },
  { path: '/ift-statistical-reports', labelKey: 'nav.iftStatisticalReports', section: 'compliance', guard: 'billing', sub: 'ift', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['ift_statistical_reports.view'] },
  { path: '/profeco-complaints', labelKey: 'nav.profecoComplaints', section: 'compliance', guard: 'billing', sub: 'consumer', rail: true, roles: ['billing'], requiredLocale: 'MX', viewPermissions: ['tickets.view'] },
  {
    path: '/snii-infrastructure',
    labelKey: 'nav.sniiInfrastructure',
    section: 'compliance',
    guard: 'any',
    sub: 'ift',
    rail: true,
    requiredLocale: 'MX',
    requiredAnyPermissions: ['snii_reporting.view'],
    keywords: ['snii', 'crt', 'torres', 'infraestructura', 'fiber', 'towers'],
  },
  // deliberately NOT MX-gated — Compliance still renders for non-Mexico orgs
  {
    path: '/regulatory-compliance', labelKey: 'nav.regulatoryCompliance', section: 'compliance', guard: 'any', sub: 'general', rail: true,
    requiredAnyPermissions: [
      'subscriber_consents.view', 'dsar_requests.view', 'gov_data_requests.view',
      'identity_verification.view', 'phone_number_inventory.view', 'uso_obligations.view',
      'service_modification_notices.view', 'contract_templates_mx.view',
      'data_residency.view', 'report_access_logs.view', 'audit_export.view',
    ],
  },

  // --- Admin (hub: /admin) ---------------------------------------------------------
  { path: '/users', labelKey: 'nav.users', section: 'admin', guard: 'admin', card: 'peopleAccess', rail: true, viewPermissions: ['users.view'] },
  { path: '/roles', labelKey: 'nav.roles', section: 'admin', guard: 'admin', card: 'peopleAccess', rail: true, viewPermissions: ['roles.view'] },
  { path: '/organizations', labelKey: 'nav.organizations', section: 'admin', guard: 'admin', card: 'organization', rail: true, viewPermissions: ['organizations.view'] },
  { path: '/settings', labelKey: 'nav.settings', section: 'admin', guard: 'admin', card: 'organization', rail: true, viewPermissions: ['settings.view'] },
  { path: '/automation', labelKey: 'nav.automation', section: 'admin', guard: 'admin', card: 'automationIntegrations', rail: true, viewPermissions: ['automation_rules.view', 'batch_jobs.view', 'provisioning_pipelines.view'] },
  { path: '/audit-logs', labelKey: 'nav.auditLogs', section: 'admin', guard: 'admin', card: 'governance', rail: true, viewPermissions: ['audit_logs.view'] },
  { path: '/security-access-control', labelKey: 'nav.securityAccessControl', section: 'admin', guard: 'admin', card: 'peopleAccess', viewPermissions: ['webauthn.view', 'password_policy.view', 'admin_ip_allowlist.view'] },
  { path: '/api-tokens', labelKey: 'nav.apiTokens', section: 'admin', guard: 'admin', card: 'peopleAccess', viewPermissions: ['api_tokens.view'] },
  { path: '/resellers', labelKey: 'nav.resellers', section: 'admin', guard: 'admin', card: 'organization', viewPermissions: ['resellers.view'] },
  { path: '/sla-definitions', labelKey: 'nav.slaDefinitions', section: 'admin', guard: 'admin', card: 'organization', viewPermissions: ['sla_definitions.view'] },
  { path: '/scheduled-tasks', labelKey: 'nav.scheduledTasks', section: 'admin', guard: 'admin', card: 'automationIntegrations', viewPermissions: ['scheduled_tasks.view'] },
  { path: '/queue-stats', labelKey: 'nav.queueStats', section: 'admin', guard: 'admin', card: 'automationIntegrations', viewPermissions: ['settings.view'] },
  { path: '/webhooks', labelKey: 'nav.webhooks', section: 'admin', guard: 'admin', card: 'automationIntegrations', viewPermissions: ['webhooks.view'] },
  { path: '/integrations', labelKey: 'nav.integrations', section: 'admin', guard: 'admin', card: 'automationIntegrations', viewPermissions: ['integration_connections.view', 'integration_providers.view', 'integration_sync_logs.view'] },
  { path: '/message-templates', labelKey: 'nav.messageTemplates', section: 'admin', guard: 'admin', card: 'automationIntegrations', viewPermissions: ['settings.view'] },
  { path: '/document-templates', keywords: ['contrato', 'adhesion', 'firma', 'legal'], labelKey: 'nav.documentTemplates', section: 'admin', guard: 'admin', card: 'governance', requiredLocale: 'MX', viewPermissions: ['document_templates.view'] },
  { path: '/ai-assistant', labelKey: 'nav.aiAssistant', section: 'admin', guard: 'admin', card: 'ai', viewPermissions: ['ai.policy.read', 'ai.providers.read'] },
  { path: '/ai-support', labelKey: 'nav.aiSupport', section: 'admin', guard: 'admin', card: 'ai', viewPermissions: ['support.conversations.view', 'support.kb.view'] },
  { path: '/dsar', labelKey: 'nav.dsar', section: 'admin', guard: 'admin', card: 'governance', viewPermissions: ['clients.view', 'dsar_requests.manage', 'connection_logs.export'] },
  { path: '/dr-drill', labelKey: 'nav.drDrill', section: 'admin', guard: 'admin', card: 'governance', installOperatorOnly: true, viewPermissions: ['settings.view'] },
  { path: '/backups', labelKey: 'nav.backups', section: 'admin', guard: 'admin', card: 'governance', installOperatorOnly: true, viewPermissions: ['backup_settings.view'] },
  { path: '/admin/user-tunnels', labelKey: 'nav.adminUserTunnels', section: 'admin', guard: 'admin', card: 'governance', viewPermissions: ['wireguard.peers.admin'] },
];

// =============================================================================
// Visibility + tree helpers
// =============================================================================

export interface NavUser {
  role: string;
  organization_locale?: string;
  permissions?: string[];
  is_install_operator?: boolean;
}

type Visibility = {
  guard?: Guard; roles?: Role[]; requiredLocale?: 'MX'; requiredAnyPermissions?: string[];
  viewPermissions?: string[]; installOperatorOnly?: boolean;
};

/**
 * Whether the session's resolved permissions open a page, or null when the
 * session has none (then the role tiers decide). Custom groups and grants to
 * built-in groups count exactly as the backend counts them (FE-25).
 */
export function permitsByPermissions(user: NavUser, node: Visibility): boolean | null {
  if (!Array.isArray(user.permissions)) return null;
  const needed = node.viewPermissions ?? node.requiredAnyPermissions;
  if (!needed) return null;
  return needed.some(permission => user.permissions!.includes(permission));
}

export function canSee(user: NavUser, node: Visibility): boolean {
  if (node.requiredLocale && user.organization_locale !== node.requiredLocale) return false;
  if (node.installOperatorOnly && user.is_install_operator !== true) return false;
  if (user.role === 'admin') return true;
  const byPermissions = permitsByPermissions(user, node);
  if (byPermissions !== null) return byPermissions;
  if (node.requiredAnyPermissions
      && !node.requiredAnyPermissions.some(permission => user.permissions?.includes(permission))) return false;
  // A row whose route guard the user fails would render <NotAllowed/> — hide it.
  if (node.guard && node.guard !== 'any' && !hasRole(user.role, node.guard)) return false;
  // readonly sees everything its guards allow after any explicit permission gate.
  if (user.role === 'readonly') return true;
  return !node.roles || node.roles.includes(user.role as Role);
}

/** Rail rows of a section, in registry order. */
export function visibleRailItems(user: NavUser, sectionId: SectionId): RouteDef[] {
  return ROUTES.filter(r => r.section === sectionId && r.rail && canSee(user, r));
}

/** Everything reachable in a section (rail + hub cards) — the "View all N" count. */
export function visibleSectionCount(user: NavUser, sectionId: SectionId): number {
  return ROUTES.filter(r => r.section === sectionId && canSee(user, r)).length;
}

/** Whether the hub header link / "View all" row may be shown. */
export function canSeeHub(user: NavUser, section: SectionDef): boolean {
  if (section.kind !== 'hub' || !section.hubPath) return false;
  // With resolved permissions, a hub is worth opening when it has a card to show.
  if (Array.isArray(user.permissions) && user.role !== 'admin') return visibleSectionCount(user, section.id) > 0;
  return canSee(user, { guard: section.hubGuard, roles: section.hubRoles });
}

/** Hub card contents for HubPage, keyed by card id in HUB_CARDS order. */
export function visibleHubCards(user: NavUser, sectionId: SectionId): { card: string; items: RouteDef[] }[] {
  const order = HUB_CARDS[sectionId] ?? [];
  return order
    .map(card => ({
      card,
      items: ROUTES.filter(r => r.section === sectionId && r.card === card && canSee(user, r)),
    }))
    .filter(c => c.items.length > 0);
}

const HUB_PATHS: Record<string, SectionId> = { '/billing': 'billing', '/network': 'network', '/admin': 'admin' };

/** Owning section for a pathname (active trail) — longest-prefix match. */
export function sectionForPath(pathname: string): SectionId | null {
  if (pathname === '/') return 'dashboard';
  const candidates: { path: string; section: SectionId }[] = [
    ...ROUTES.map(r => ({ path: r.path, section: r.section })),
    ...Object.entries(HUB_PATHS).map(([path, section]) => ({ path, section })),
  ];
  let best: { path: string; section: SectionId } | null = null;
  for (const c of candidates) {
    if (pathname === c.path || pathname.startsWith(`${c.path}/`)) {
      if (!best || c.path.length > best.path.length) best = c;
    }
  }
  return best?.section ?? null;
}

/** Best matching registered route for a pathname (detail pages inherit their list label). */
export function routeForPath(pathname: string): RouteDef | null {
  let best: RouteDef | null = null;
  for (const route of ROUTES) {
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      if (!best || route.path.length > best.path.length) best = route;
    }
  }
  return best;
}

/** Section auto-opened on first load, per persona. */
export function defaultExpandedSection(role: string): SectionId | null {
  switch (role) {
    case 'technician': return 'fieldops';
    case 'billing': return 'billing';
    case 'support': return 'support';
    case 'readonly': return null;
    default: return 'clients'; // admin
  }
}
