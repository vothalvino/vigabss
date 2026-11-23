// Shapes of the contract page's GraphQL sub-resources.

export interface ContractClient {
  id: string;
  name: string;
  status: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  total: string;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  status: string;
}

export interface Device {
  id: string;
  name: string;
  type: string | null;
  manufacturer: string | null;
  model: string | null;
  macAddress: string | null;
  ipAddress: string | null;
  status: string;
}

export interface ContractAddon {
  id: string;
  addonName: string | null;
  addonType: string | null;
  quantity: string | null;
  unitPrice: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string;
}
