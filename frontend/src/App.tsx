// =============================================================================
// VigaBSS 5.0 — App Router
// =============================================================================
// Implements role-based UI routing:
//   • Public routes: /login, /forgot-password, /reset-password, /verify-email
//   • Protected routes (any authenticated user): /, /clients, /contracts, etc.
//   • Admin-only routes: /users, /settings
//   • Billing+ routes: /reports
// =============================================================================

import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/auth/AuthContext';
import { PrivateRoute } from '@/auth/PrivateRoute';
import { Layout } from '@/components/Layout';
import { Login } from '@/pages/Login';
import { PortalAuthProvider } from '@/auth/PortalAuthContext';
import { PortalRoute } from '@/auth/PortalRoute';
import { PortalLayout } from '@/components/PortalLayout';
import { NotFound } from '@/pages/NotFound';
import { LoadingState } from '@/components/FetchStates';
import { DarkModeProvider } from '@/auth/DarkModeContext';
import { AccentProvider } from '@/auth/AccentContext';
import { DialogFocusManager } from '@/components/DialogFocusManager';

// Every page but the sign-in screens is its own chunk, loaded on first visit
// (FE-21): the app shipped as one 3.9 MB bundle. The layouts show a loading
// state in place of the page while its chunk arrives.
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword').then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('@/pages/ResetPassword').then((m) => ({ default: m.ResetPassword })));
const VerifyEmail = lazy(() => import('@/pages/VerifyEmail').then((m) => ({ default: m.VerifyEmail })));
const PortalLogin = lazy(() => import('@/pages/portal/PortalLogin').then((m) => ({ default: m.PortalLogin })));
const PortalForgotPassword = lazy(() => import('@/pages/portal/PortalForgotPassword').then((m) => ({ default: m.PortalForgotPassword })));
const PortalResetPassword = lazy(() => import('@/pages/portal/PortalResetPassword').then((m) => ({ default: m.PortalResetPassword })));
const PortalDashboard = lazy(() => import('@/pages/portal/PortalDashboard').then((m) => ({ default: m.PortalDashboard })));
const PortalInvoices = lazy(() => import('@/pages/portal/PortalInvoices').then((m) => ({ default: m.PortalInvoices })));
const PortalDocuments = lazy(() => import('@/pages/portal/PortalDocuments').then((m) => ({ default: m.PortalDocuments })));
const PortalInvoiceDetail = lazy(() => import('@/pages/portal/PortalInvoiceDetail').then((m) => ({ default: m.PortalInvoiceDetail })));
const PortalTickets = lazy(() => import('@/pages/portal/PortalTickets').then((m) => ({ default: m.PortalTickets })));
const PortalTicketDetail = lazy(() => import('@/pages/portal/PortalTicketDetail').then((m) => ({ default: m.PortalTicketDetail })));
const PortalAccount = lazy(() => import('@/pages/portal/PortalAccount').then((m) => ({ default: m.PortalAccount })));
const PortalKb = lazy(() => import('@/pages/portal/PortalKb').then((m) => ({ default: m.PortalKb })));
const PortalSpeedTest = lazy(() => import('@/pages/portal/PortalSpeedTest').then((m) => ({ default: m.PortalSpeedTest })));
const PortalChat = lazy(() => import('@/pages/portal/PortalChat').then((m) => ({ default: m.PortalChat })));
const PortalPayments = lazy(() => import('@/pages/portal/PortalPayments').then((m) => ({ default: m.PortalPayments })));
const PortalDataPacks = lazy(() => import('@/pages/portal/PortalDataPacks').then((m) => ({ default: m.PortalDataPacks })));
const PortalSecurity = lazy(() => import('@/pages/portal/PortalSecurity').then((m) => ({ default: m.PortalSecurity })));
const PortalPrivacy = lazy(() => import('@/pages/portal/PortalPrivacy').then((m) => ({ default: m.PortalPrivacy })));
const Dashboard = lazy(() => import('@/pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const ClientList = lazy(() => import('@/pages/ClientList').then((m) => ({ default: m.ClientList })));
const ClientDetail = lazy(() => import('@/pages/ClientDetail').then((m) => ({ default: m.ClientDetail })));
const ClientGroupList = lazy(() => import('@/pages/ClientGroupList').then((m) => ({ default: m.ClientGroupList })));
const LeadList = lazy(() => import('@/pages/LeadList').then((m) => ({ default: m.LeadList })));
const ServiceOrderList = lazy(() => import('@/pages/ServiceOrderList').then((m) => ({ default: m.ServiceOrderList })));
const WinbackCampaignList = lazy(() => import('@/pages/WinbackCampaignList').then((m) => ({ default: m.WinbackCampaignList })));
const CommunicationCampaignList = lazy(() => import('@/pages/CommunicationCampaignList').then((m) => ({ default: m.CommunicationCampaignList })));
const ChurnAnalytics = lazy(() => import('@/pages/ChurnAnalytics').then((m) => ({ default: m.ChurnAnalytics })));
const ContractList = lazy(() => import('@/pages/ContractList').then((m) => ({ default: m.ContractList })));
const ContractDetail = lazy(() => import('@/pages/ContractDetail').then((m) => ({ default: m.ContractDetail })));
const InvoiceList = lazy(() => import('@/pages/InvoiceList').then((m) => ({ default: m.InvoiceList })));
const InvoiceDetail = lazy(() => import('@/pages/InvoiceDetail').then((m) => ({ default: m.InvoiceDetail })));
const PaymentList = lazy(() => import('@/pages/PaymentList').then((m) => ({ default: m.PaymentList })));
const PaymentDetail = lazy(() => import('@/pages/PaymentDetail').then((m) => ({ default: m.PaymentDetail })));
const TicketList = lazy(() => import('@/pages/TicketList').then((m) => ({ default: m.TicketList })));
const TicketDetail = lazy(() => import('@/pages/TicketDetail').then((m) => ({ default: m.TicketDetail })));
const FollowUpReminderList = lazy(() => import('@/pages/FollowUpReminderList').then((m) => ({ default: m.FollowUpReminderList })));
const SatisfactionSurveyList = lazy(() => import('@/pages/SatisfactionSurveyList').then((m) => ({ default: m.SatisfactionSurveyList })));
const EscalationList = lazy(() => import('@/pages/EscalationList').then((m) => ({ default: m.EscalationList })));
const PortalServiceRequestList = lazy(() => import('@/pages/PortalServiceRequestList').then((m) => ({ default: m.PortalServiceRequestList })));
const DeviceMap = lazy(() => import('@/pages/DeviceMap').then((m) => ({ default: m.DeviceMap })));
const UserList = lazy(() => import('@/pages/UserList').then((m) => ({ default: m.UserList })));
const CfdiList = lazy(() => import('@/pages/CfdiList').then((m) => ({ default: m.CfdiList })));
const PlanList = lazy(() => import('@/pages/PlanList').then((m) => ({ default: m.PlanList })));
const QuoteList = lazy(() => import('@/pages/QuoteList').then((m) => ({ default: m.QuoteList })));
const QuoteDetail = lazy(() => import('@/pages/QuoteDetail').then((m) => ({ default: m.QuoteDetail })));
const CreditNoteList = lazy(() => import('@/pages/CreditNoteList').then((m) => ({ default: m.CreditNoteList })));
const ExpenseList = lazy(() => import('@/pages/ExpenseList').then((m) => ({ default: m.ExpenseList })));
const InventoryList = lazy(() => import('@/pages/InventoryList').then((m) => ({ default: m.InventoryList })));
const WarehouseList = lazy(() => import('@/pages/WarehouseList').then((m) => ({ default: m.WarehouseList })));
const VendorList = lazy(() => import('@/pages/VendorList').then((m) => ({ default: m.VendorList })));
const PurchaseOrderList = lazy(() => import('@/pages/PurchaseOrderList').then((m) => ({ default: m.PurchaseOrderList })));
const PurchaseOrderDetail = lazy(() => import('@/pages/PurchaseOrderDetail').then((m) => ({ default: m.PurchaseOrderDetail })));
const CoverageZoneMap = lazy(() => import('@/pages/CoverageZoneMap').then((m) => ({ default: m.CoverageZoneMap })));
const RadiusSessions = lazy(() => import('@/pages/RadiusSessions').then((m) => ({ default: m.RadiusSessions })));
const SessionAccounting = lazy(() => import('@/pages/SessionAccounting').then((m) => ({ default: m.SessionAccounting })));
const SnmpMetrics = lazy(() => import('@/pages/SnmpMetrics').then((m) => ({ default: m.SnmpMetrics })));
const SnmpTraps = lazy(() => import('@/pages/SnmpTraps').then((m) => ({ default: m.SnmpTraps })));
const SiteList = lazy(() => import('@/pages/SiteList').then((m) => ({ default: m.SiteList })));
const SiteDetail = lazy(() => import('@/pages/SiteDetail').then((m) => ({ default: m.SiteDetail })));
const NasList = lazy(() => import('@/pages/NasList').then((m) => ({ default: m.NasList })));
const NasDetail = lazy(() => import('@/pages/NasDetail').then((m) => ({ default: m.NasDetail })));
const DeviceDetail = lazy(() => import('@/pages/DeviceDetail').then((m) => ({ default: m.DeviceDetail })));
const MacMoveEvents = lazy(() => import('@/pages/MacMoveEvents').then((m) => ({ default: m.MacMoveEvents })));
const MessageOutbox = lazy(() => import('@/pages/MessageOutbox').then((m) => ({ default: m.MessageOutbox })));
const PppoeServiceProfileList = lazy(() => import('@/pages/PppoeServiceProfileList').then((m) => ({ default: m.PppoeServiceProfileList })));
const PppoeDiagnostics = lazy(() => import('@/pages/PppoeDiagnostics').then((m) => ({ default: m.PppoeDiagnostics })));
const DhcpServerList = lazy(() => import('@/pages/DhcpServerList').then((m) => ({ default: m.DhcpServerList })));
const NatManagementList = lazy(() => import('@/pages/NatManagementList').then((m) => ({ default: m.NatManagementList })));
const PtrRecordList = lazy(() => import('@/pages/PtrRecordList').then((m) => ({ default: m.PtrRecordList })));
const Ipv6ManagementPage = lazy(() => import('@/pages/Ipv6ManagementPage').then((m) => ({ default: m.Ipv6ManagementPage })));
const TransitionMechanismsPage = lazy(() => import('@/pages/TransitionMechanismsPage').then((m) => ({ default: m.TransitionMechanismsPage })));
const DeviceGroupList = lazy(() => import('@/pages/DeviceGroupList').then((m) => ({ default: m.DeviceGroupList })));
const DiscoveryScanList = lazy(() => import('@/pages/DiscoveryScanList').then((m) => ({ default: m.DiscoveryScanList })));
const DeviceImport = lazy(() => import('@/pages/DeviceImport').then((m) => ({ default: m.DeviceImport })));
const DataImport = lazy(() => import('@/pages/DataImport').then((m) => ({ default: m.DataImport })));
const TrapForwardingRuleList = lazy(() => import('@/pages/TrapForwardingRuleList').then((m) => ({ default: m.TrapForwardingRuleList })));
const PollerNodeList = lazy(() => import('@/pages/PollerNodeList').then((m) => ({ default: m.PollerNodeList })));
const DevicePollingConfigList = lazy(() => import('@/pages/DevicePollingConfigList').then((m) => ({ default: m.DevicePollingConfigList })));
const PollerPerformanceDashboard = lazy(() => import('@/pages/PollerPerformanceDashboard').then((m) => ({ default: m.PollerPerformanceDashboard })));
const AlertEscalationChainList = lazy(() => import('@/pages/AlertEscalationChainList').then((m) => ({ default: m.AlertEscalationChainList })));
const MaintenanceWindowList = lazy(() => import('@/pages/MaintenanceWindowList').then((m) => ({ default: m.MaintenanceWindowList })));
const AlertChannelList = lazy(() => import('@/pages/AlertChannelList').then((m) => ({ default: m.AlertChannelList })));
const AlertSuppressionList = lazy(() => import('@/pages/AlertSuppressionList').then((m) => ({ default: m.AlertSuppressionList })));
const IpPoolList = lazy(() => import('@/pages/IpPoolList').then((m) => ({ default: m.IpPoolList })));
const IpAssignmentList = lazy(() => import('@/pages/IpAssignmentList').then((m) => ({ default: m.IpAssignmentList })));
const VlanList = lazy(() => import('@/pages/VlanList').then((m) => ({ default: m.VlanList })));
const ServiceAreaList = lazy(() => import('@/pages/ServiceAreaList').then((m) => ({ default: m.ServiceAreaList })));
const OutageList = lazy(() => import('@/pages/OutageList').then((m) => ({ default: m.OutageList })));
const SpeedTestList = lazy(() => import('@/pages/SpeedTestList').then((m) => ({ default: m.SpeedTestList })));
const ConnectionLogList = lazy(() => import('@/pages/ConnectionLogList').then((m) => ({ default: m.ConnectionLogList })));
const NetworkHealthList = lazy(() => import('@/pages/NetworkHealthList').then((m) => ({ default: m.NetworkHealthList })));
const SnmpProfileList = lazy(() => import('@/pages/SnmpProfileList').then((m) => ({ default: m.SnmpProfileList })));
const DeviceConfigBackupList = lazy(() => import('@/pages/DeviceConfigBackupList').then((m) => ({ default: m.DeviceConfigBackupList })));
const ConfigTemplateList = lazy(() => import('@/pages/ConfigTemplateList').then((m) => ({ default: m.ConfigTemplateList })));
const ConfigBackupScheduleList = lazy(() => import('@/pages/ConfigBackupScheduleList').then((m) => ({ default: m.ConfigBackupScheduleList })));
const ConfigComplianceRuleList = lazy(() => import('@/pages/ConfigComplianceRuleList').then((m) => ({ default: m.ConfigComplianceRuleList })));
const SuspensionRuleList = lazy(() => import('@/pages/SuspensionRuleList').then((m) => ({ default: m.SuspensionRuleList })));
const SuspensionConsole = lazy(() => import('@/pages/SuspensionConsole').then((m) => ({ default: m.SuspensionConsole })));
const TechnicianMap = lazy(() => import('@/pages/TechnicianMap').then((m) => ({ default: m.TechnicianMap })));
const Reports = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.Reports })));
const AnalyticsDashboard = lazy(() => import('@/pages/AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })));
const TaxReports = lazy(() => import('@/pages/TaxReports').then((m) => ({ default: m.TaxReports })));
const InvoiceSettings = lazy(() => import('@/pages/InvoiceSettings').then((m) => ({ default: m.InvoiceSettings })));
const LateFeeRuleList = lazy(() => import('@/pages/LateFeeRuleList').then((m) => ({ default: m.LateFeeRuleList })));
const PaymentReminderSettings = lazy(() => import('@/pages/PaymentReminderSettings').then((m) => ({ default: m.PaymentReminderSettings })));
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));
const ProfecoComplaints = lazy(() => import('@/pages/ProfecoComplaints').then((m) => ({ default: m.ProfecoComplaints })));
const RegulatoryCompliancePage = lazy(() => import('@/pages/RegulatoryCompliancePage'));
const SniiInfrastructureReportingPage = lazy(() => import('@/pages/SniiInfrastructureReportingPage').then((m) => ({ default: m.SniiInfrastructureReportingPage })));
const SlaDefinitionList = lazy(() => import('@/pages/SlaDefinitionList').then((m) => ({ default: m.SlaDefinitionList })));
const RoleList = lazy(() => import('@/pages/RoleList').then((m) => ({ default: m.RoleList })));
const ApiTokenList = lazy(() => import('@/pages/ApiTokenList').then((m) => ({ default: m.ApiTokenList })));
const WebhookList = lazy(() => import('@/pages/WebhookList').then((m) => ({ default: m.WebhookList })));
const AuditLogList = lazy(() => import('@/pages/AuditLogList').then((m) => ({ default: m.AuditLogList })));
const ScheduledTaskList = lazy(() => import('@/pages/ScheduledTaskList').then((m) => ({ default: m.ScheduledTaskList })));
const OrganizationList = lazy(() => import('@/pages/OrganizationList').then((m) => ({ default: m.OrganizationList })));
const OrganizationDetail = lazy(() => import('@/pages/OrganizationDetail').then((m) => ({ default: m.OrganizationDetail })));
const DsarTool = lazy(() => import('@/pages/DsarTool').then((m) => ({ default: m.DsarTool })));
const DrDrillStatus = lazy(() => import('@/pages/DrDrillStatus').then((m) => ({ default: m.DrDrillStatus })));
const BackupSettings = lazy(() => import('@/pages/BackupSettings').then((m) => ({ default: m.BackupSettings })));
const QueueStats = lazy(() => import('@/pages/QueueStats').then((m) => ({ default: m.QueueStats })));
const CsdCertificateList = lazy(() => import('@/pages/CsdCertificateList').then((m) => ({ default: m.CsdCertificateList })));
const SubscriberCertificateList = lazy(() => import('@/pages/SubscriberCertificateList').then((m) => ({ default: m.SubscriberCertificateList })));
const PacProviderList = lazy(() => import('@/pages/PacProviderList').then((m) => ({ default: m.PacProviderList })));
const SatCatalogList = lazy(() => import('@/pages/SatCatalogList').then((m) => ({ default: m.SatCatalogList })));
const RegulatoryFilingList = lazy(() => import('@/pages/RegulatoryFilingList').then((m) => ({ default: m.RegulatoryFilingList })));
const ConcessionTitleList = lazy(() => import('@/pages/ConcessionTitleList').then((m) => ({ default: m.ConcessionTitleList })));
const IftStatisticalReportList = lazy(() => import('@/pages/IftStatisticalReportList').then((m) => ({ default: m.IftStatisticalReportList })));
const FacturaPublicaList = lazy(() => import('@/pages/FacturaPublicaList').then((m) => ({ default: m.FacturaPublicaList })));
const MessageTemplateList = lazy(() => import('@/pages/MessageTemplateList').then((m) => ({ default: m.MessageTemplateList })));
const DocumentTemplates = lazy(() => import('@/pages/DocumentTemplates').then((m) => ({ default: m.DocumentTemplates })));
const PromotionList = lazy(() => import('@/pages/PromotionList').then((m) => ({ default: m.PromotionList })));
const TaxRuleList = lazy(() => import('@/pages/TaxRuleList').then((m) => ({ default: m.TaxRuleList })));
const TaxRateList = lazy(() => import('@/pages/TaxRateList').then((m) => ({ default: m.TaxRateList })));
const PaymentGatewayList = lazy(() => import('@/pages/PaymentGatewayList').then((m) => ({ default: m.PaymentGatewayList })));
const PaymentProblems = lazy(() => import('@/pages/PaymentProblems').then((m) => ({ default: m.PaymentProblems })));
const PaymentTransactionList = lazy(() => import('@/pages/PaymentTransactionList').then((m) => ({ default: m.PaymentTransactionList })));
const RecurringPaymentProfileList = lazy(() => import('@/pages/RecurringPaymentProfileList').then((m) => ({ default: m.RecurringPaymentProfileList })));
const PaymentPlanList = lazy(() => import('@/pages/PaymentPlanList').then((m) => ({ default: m.PaymentPlanList })));
const CashReconciliationList = lazy(() => import('@/pages/CashReconciliationList').then((m) => ({ default: m.CashReconciliationList })));
const RefundRequestList = lazy(() => import('@/pages/RefundRequestList').then((m) => ({ default: m.RefundRequestList })));
const BillingDisputeList = lazy(() => import('@/pages/BillingDisputeList').then((m) => ({ default: m.BillingDisputeList })));
const ChargebackList = lazy(() => import('@/pages/ChargebackList').then((m) => ({ default: m.ChargebackList })));
const BillingAdjustmentList = lazy(() => import('@/pages/BillingAdjustmentList').then((m) => ({ default: m.BillingAdjustmentList })));
const AIAssistantSettings = lazy(() => import('@/pages/AIAssistantSettings').then((m) => ({ default: m.AIAssistantSettings })));
const OltManagementPage = lazy(() => import('@/pages/OltManagementPage').then((m) => ({ default: m.OltManagementPage })));
const OnuManagementPage = lazy(() => import('@/pages/OnuManagementPage').then((m) => ({ default: m.OnuManagementPage })));
const PonPortManagementPage = lazy(() => import('@/pages/PonPortManagementPage').then((m) => ({ default: m.PonPortManagementPage })));
const FiberPlantManagementPage = lazy(() => import('@/pages/FiberPlantManagementPage').then((m) => ({ default: m.FiberPlantManagementPage })));
const CpeManagementPage = lazy(() => import('@/pages/CpeManagementPage').then((m) => ({ default: m.CpeManagementPage })));
const CpeProfilesPage = lazy(() => import('@/pages/CpeProfilesPage').then((m) => ({ default: m.CpeProfilesPage })));
const CpeDiagnosticsPage = lazy(() => import('@/pages/CpeDiagnosticsPage').then((m) => ({ default: m.CpeDiagnosticsPage })));
const CpeInventoryPage = lazy(() => import('@/pages/CpeInventoryPage').then((m) => ({ default: m.CpeInventoryPage })));
const WirelessManagementPage = lazy(() => import('@/pages/WirelessManagementPage').then((m) => ({ default: m.WirelessManagementPage })));
const WirelessMetricsPage = lazy(() => import('@/pages/WirelessMetricsPage').then((m) => ({ default: m.WirelessMetricsPage })));
const QosBandwidthPage = lazy(() => import('@/pages/QosBandwidthPage').then((m) => ({ default: m.QosBandwidthPage })));
const NocDashboard = lazy(() => import('@/pages/NocDashboard').then((m) => ({ default: m.NocDashboard })));
const WorkOrders = lazy(() => import('@/pages/WorkOrders').then((m) => ({ default: m.WorkOrders })));
const TopologyMapPage = lazy(() => import('@/pages/TopologyMapPage').then((m) => ({ default: m.TopologyMapPage })));
const InventoryManagement = lazy(() => import('@/pages/InventoryManagement').then((m) => ({ default: m.InventoryManagement })));
const HubPage = lazy(() => import('@/pages/HubPage').then((m) => ({ default: m.HubPage })));
const SecurityAccessControlPage = lazy(() => import('@/pages/SecurityAccessControlPage').then((m) => ({ default: m.SecurityAccessControlPage })));
const AutomationPage = lazy(() => import('@/pages/AutomationPage'));
const ResellerPage = lazy(() => import('@/pages/ResellerPage'));
const IntegrationsPage = lazy(() => import('@/pages/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })));
const AiSupportPage = lazy(() => import('@/pages/AiSupportPage').then((m) => ({ default: m.AiSupportPage })));
const UserWgTunnels = lazy(() => import('@/pages/UserWgTunnels').then((m) => ({ default: m.UserWgTunnels })));
const AdminWgTunnels = lazy(() => import('@/pages/AdminWgTunnels').then((m) => ({ default: m.AdminWgTunnels })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

export function App() {
  return (
    <DarkModeProvider>
      <AccentProvider>
      <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PortalAuthProvider>
          <BrowserRouter>
            <DialogFocusManager />
            <Suspense fallback={<LoadingState />}>
            <Routes>
              {/* Public */}
              <Route path="/login" element={<Login />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/verify-email" element={<VerifyEmail />} />

              {/* ---- Client Self-Service Portal ---- */}
              <Route path="/portal/login" element={<PortalLogin />} />
              <Route path="/portal/forgot-password" element={<PortalForgotPassword />} />
              <Route path="/portal/reset-password" element={<PortalResetPassword />} />
              <Route element={<PortalRoute />}>
                <Route element={<PortalLayout />}>
                  <Route path="/portal" element={<PortalDashboard />} />
                  <Route path="/portal/invoices" element={<PortalInvoices />} />
                  <Route path="/portal/invoices/:id" element={<PortalInvoiceDetail />} />
                  <Route path="/portal/documents" element={<PortalDocuments />} />
                  <Route path="/portal/tickets" element={<PortalTickets />} />
                  <Route path="/portal/tickets/:id" element={<PortalTicketDetail />} />
                  <Route path="/portal/account" element={<PortalAccount />} />
                  <Route path="/portal/kb" element={<PortalKb />} />
                  <Route path="/portal/speed-test" element={<PortalSpeedTest />} />
                  <Route path="/portal/chat" element={<PortalChat />} />
                  <Route path="/portal/payments" element={<PortalPayments />} />
                  <Route path="/portal/data-packs" element={<PortalDataPacks />} />
                  <Route path="/portal/security" element={<PortalSecurity />} />
                  <Route path="/portal/privacy" element={<PortalPrivacy />} />
                </Route>
              </Route>

            {/* Protected — any authenticated user */}
            <Route element={<PrivateRoute />}>
              <Route element={<Layout />}>
                <Route index element={<Dashboard />} />
                <Route path="clients" element={<ClientList />} />
                <Route path="clients/:id" element={<ClientDetail />} />
                <Route path="client-groups" element={<ClientGroupList />} />
                <Route path="leads" element={<LeadList />} />
                <Route path="service-orders" element={<ServiceOrderList />} />
                <Route path="contracts" element={<ContractList />} />
                <Route path="contracts/:id" element={<ContractDetail />} />
                <Route path="invoices" element={<InvoiceList />} />
                <Route path="invoices/:id" element={<InvoiceDetail />} />
                <Route path="payments" element={<PaymentList />} />
                <Route path="payments/:id" element={<PaymentDetail />} />
                <Route path="tickets" element={<TicketList />} />
                <Route path="tickets/:id" element={<TicketDetail />} />
                <Route path="communication-campaigns" element={<CommunicationCampaignList />} />
                <Route path="message-outbox" element={<MessageOutbox />} />
                <Route path="follow-up-reminders" element={<FollowUpReminderList />} />
                <Route path="satisfaction-surveys" element={<SatisfactionSurveyList />} />
                <Route path="escalations" element={<EscalationList />} />
                <Route path="self-service-requests" element={<PortalServiceRequestList />} />
                <Route path="devices" element={<DeviceMap />} />
                <Route path="devices/:id" element={<DeviceDetail />} />
                <Route path="wg-tunnels" element={<UserWgTunnels />} />
                {/* any-auth so support can reach them (backend gates via
                    outages.view / network_health.view — support has both,
                    migration 377) */}
                <Route path="outages" element={<OutageList />} />
                <Route path="network-health" element={<NetworkHealthList />} />
                {/* Backend pppoe.diagnostics / MAC-move permissions determine
                    which datasets each authenticated role may read. */}
                <Route path="pppoe-diagnostics" element={<PppoeDiagnostics />} />
                {/* Subscriber accounting is available to every authenticated
                    persona whose resolved backend permissions allow it. */}
                <Route path="connection-logs" element={<ConnectionLogList />} />
                {/* Tab visibility and every API operation are permission-gated;
                    this route also supports custom legal-response principals. */}
                <Route path="regulatory-compliance" element={<RegulatoryCompliancePage />} />
                {/* Exact infrastructure geolocation and every action are
                    permission-gated inside the MX-only SNII workflow. */}
                <Route path="snii-infrastructure" element={<SniiInfrastructureReportingPage />} />
              </Route>
            </Route>

            {/* Technician+ — technician, billing, or admin */}
            <Route element={<PrivateRoute requiredRole="technician" />}>
              <Route element={<Layout />}>
                <Route path="network" element={<HubPage section="network" />} />
                <Route path="inventory" element={<InventoryList />} />
                <Route path="warehouses" element={<WarehouseList />} />
                <Route path="vendors" element={<VendorList />} />
                <Route path="purchase-orders" element={<PurchaseOrderList />} />
                <Route path="purchase-orders/:id" element={<PurchaseOrderDetail />} />
                <Route path="radius-sessions" element={<RadiusSessions />} />
                <Route path="subscriber-certificates" element={<SubscriberCertificateList />} />
                <Route path="session-accounting" element={<SessionAccounting />} />
                <Route path="snmp-metrics" element={<SnmpMetrics />} />
                <Route path="snmp-traps" element={<SnmpTraps />} />
                <Route path="coverage-zones" element={<CoverageZoneMap />} />
                <Route path="sites" element={<SiteList />} />
                <Route path="sites/:id" element={<SiteDetail />} />
                <Route path="nas" element={<NasList />} />
                <Route path="nas/:id" element={<NasDetail />} />
                <Route path="mac-move-events" element={<MacMoveEvents />} />
                <Route path="pppoe-service-profiles" element={<PppoeServiceProfileList />} />
                <Route path="ip-pools" element={<IpPoolList />} />
                <Route path="ip-assignments" element={<IpAssignmentList />} />
                <Route path="vlans" element={<VlanList />} />
                <Route path="service-areas" element={<ServiceAreaList />} />
                <Route path="speed-tests" element={<SpeedTestList />} />
                <Route path="snmp-profiles" element={<SnmpProfileList />} />
                <Route path="device-config-backups" element={<DeviceConfigBackupList />} />
                <Route path="config-templates" element={<ConfigTemplateList />} />
                <Route path="config-backup-schedules" element={<ConfigBackupScheduleList />} />
                <Route path="config-compliance-rules" element={<ConfigComplianceRuleList />} />
                <Route path="suspension-rules" element={<SuspensionRuleList />} />
                <Route path="suspension-console" element={<SuspensionConsole />} />
                <Route path="technician-map" element={<TechnicianMap />} />
                <Route path="dhcp-servers" element={<DhcpServerList />} />
                <Route path="nat-management" element={<NatManagementList />} />
                <Route path="ptr-records" element={<PtrRecordList />} />
                <Route path="ipv6-management" element={<Ipv6ManagementPage />} />
                <Route path="transition-mechanisms" element={<TransitionMechanismsPage />} />
                <Route path="device-groups" element={<DeviceGroupList />} />
                <Route path="discovery-scans" element={<DiscoveryScanList />} />
                <Route path="device-import" element={<DeviceImport />} />
                <Route path="trap-forwarding-rules" element={<TrapForwardingRuleList />} />
                <Route path="poller-nodes" element={<PollerNodeList />} />
                <Route path="device-polling-configs" element={<DevicePollingConfigList />} />
                <Route path="poller-performance" element={<PollerPerformanceDashboard />} />
                <Route path="alert-escalation-chains" element={<AlertEscalationChainList />} />
                <Route path="maintenance-windows" element={<MaintenanceWindowList />} />
                <Route path="alert-channels" element={<AlertChannelList />} />
                <Route path="alert-suppression-rules" element={<AlertSuppressionList />} />
                <Route path="olt-management" element={<OltManagementPage />} />
                <Route path="onu-management" element={<OnuManagementPage />} />
                <Route path="pon-port-management" element={<PonPortManagementPage />} />
                <Route path="fiber-plant-management" element={<FiberPlantManagementPage />} />
                <Route path="cpe-management" element={<CpeManagementPage />} />
                <Route path="cpe-profiles" element={<CpeProfilesPage />} />
                <Route path="cpe-diagnostics" element={<CpeDiagnosticsPage />} />
                <Route path="cpe-inventory" element={<CpeInventoryPage />} />
                <Route path="wireless" element={<WirelessManagementPage />} />
                <Route path="wireless-metrics" element={<WirelessMetricsPage />} />
                <Route path="qos-bandwidth" element={<QosBandwidthPage />} />
                <Route path="noc-dashboard" element={<NocDashboard />} />
                <Route path="work-orders" element={<WorkOrders />} />
                <Route path="topology-map" element={<TopologyMapPage />} />
                <Route path="inventory-management" element={<InventoryManagement />} />
              </Route>
            </Route>

            {/* Billing+ — billing or admin */}
            <Route element={<PrivateRoute requiredRole="billing" />}>
              <Route element={<Layout />}>
                <Route path="billing" element={<HubPage section="billing" />} />
                <Route path="cfdi" element={<CfdiList />} />
                <Route path="plans" element={<PlanList />} />
                <Route path="quotes" element={<QuoteList />} />
                <Route path="quotes/:id" element={<QuoteDetail />} />
                <Route path="credit-notes" element={<CreditNoteList />} />
                <Route path="expenses" element={<ExpenseList />} />
                <Route path="promotions" element={<PromotionList />} />
                <Route path="tax-rules" element={<TaxRuleList />} />
                <Route path="tax-rates" element={<TaxRateList />} />
                <Route path="payment-gateways" element={<PaymentGatewayList />} />
                <Route path="payment-problems" element={<PaymentProblems />} />
                <Route path="payment-transactions" element={<PaymentTransactionList />} />
                <Route path="recurring-payment-profiles" element={<RecurringPaymentProfileList />} />
                <Route path="payment-plans" element={<PaymentPlanList />} />
                <Route path="cash-reconciliation" element={<CashReconciliationList />} />
                <Route path="refund-requests" element={<RefundRequestList />} />
                <Route path="billing-disputes" element={<BillingDisputeList />} />
                <Route path="chargebacks" element={<ChargebackList />} />
                <Route path="billing-adjustments" element={<BillingAdjustmentList />} />
                <Route path="winback-campaigns" element={<WinbackCampaignList />} />
                <Route path="churn-analytics" element={<ChurnAnalytics />} />
                <Route path="csd-certificates" element={<CsdCertificateList />} />
                <Route path="pac-providers" element={<PacProviderList />} />
                <Route path="sat-catalogs" element={<SatCatalogList />} />
                <Route path="regulatory-filings" element={<RegulatoryFilingList />} />
                <Route path="concession-titles" element={<ConcessionTitleList />} />
                <Route path="ift-statistical-reports" element={<IftStatisticalReportList />} />
                <Route path="facturas-publicas" element={<FacturaPublicaList />} />
                <Route path="reports" element={<Reports />} />
                <Route path="analytics-dashboard" element={<AnalyticsDashboard />} />
                <Route path="tax-reports" element={<TaxReports />} />
                <Route path="invoice-settings" element={<InvoiceSettings />} />
                <Route path="data-import" element={<DataImport />} />
                <Route path="late-fee-rules" element={<LateFeeRuleList />} />
                <Route path="payment-reminder-settings" element={<PaymentReminderSettings />} />
                <Route path="profeco-complaints" element={<ProfecoComplaints />} />
              </Route>
            </Route>

            {/* Admin-only */}
            <Route element={<PrivateRoute requiredRole="admin" />}>
              <Route element={<Layout />}>
                <Route path="admin" element={<HubPage section="admin" />} />
                <Route path="users" element={<UserList />} />
                <Route path="organizations" element={<OrganizationList />} />
                <Route path="organizations/:id" element={<OrganizationDetail />} />
                <Route path="dsar" element={<DsarTool />} />
                <Route path="dr-drill" element={<DrDrillStatus />} />
                <Route path="backups" element={<BackupSettings />} />
                <Route path="sla-definitions" element={<SlaDefinitionList />} />
                <Route path="roles" element={<RoleList />} />
                <Route path="api-tokens" element={<ApiTokenList />} />
                <Route path="webhooks" element={<WebhookList />} />
                <Route path="audit-logs" element={<AuditLogList />} />
                <Route path="scheduled-tasks" element={<ScheduledTaskList />} />
                <Route path="queue-stats" element={<QueueStats />} />
                <Route path="settings" element={<Settings />} />
                <Route path="message-templates" element={<MessageTemplateList />} />
                <Route path="document-templates" element={<DocumentTemplates />} />
                <Route path="ai-assistant" element={<AIAssistantSettings />} />
                <Route path="security-access-control" element={<SecurityAccessControlPage />} />
                <Route path="automation" element={<AutomationPage />} />
                <Route path="resellers" element={<ResellerPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="ai-support" element={<AiSupportPage />} />
                <Route path="admin/user-tunnels" element={<AdminWgTunnels />} />
              </Route>
            </Route>

            {/* Fallback */}
            <Route path="404" element={<NotFound />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
          </Routes>
            </Suspense>
        </BrowserRouter>
        </PortalAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
      </AccentProvider>
    </DarkModeProvider>
  );
}
