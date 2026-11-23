// ---------------------------------------------------------------------------
// GraphQL query — fetches the contract + all sub-resources in one request
// ---------------------------------------------------------------------------

export const CONTRACT_DETAIL_QUERY = /* GraphQL */ `
  query ContractDetail($id: ID!) {
    contract(id: $id) {
      id
      clientId
      planId
      connectionType
      accessTechnology
      accessTechnologyOverride
      startDate
      endDate
      billingDay
      status
      ipAddress
      priceOverride
      mxContractEnvironment
      notes
      createdAt
      client {
        id
        name
        status
      }
      invoices {
        id
        invoiceNumber
        total
        currency
        dueDate
        paidAt
        status
      }
      devices {
        id
        name
        type
        manufacturer
        model
        macAddress
        ipAddress
        status
      }
      addons {
        id
        addonName
        addonType
        quantity
        unitPrice
        startDate
        endDate
        status
      }
    }
  }
`;
