// =============================================================================
// VigaBSS 5.0 — CPE Task Validation Schemas (§8.1)
// =============================================================================

const createCpeTask = {
  task_type: {
    type: 'string',
    required: true,
    enum: [
      'get_parameter_values', 'set_parameter_values', 'get_parameter_names',
      'download', 'reboot', 'factory_reset', 'add_object', 'delete_object',
    ],
  },
  // An object or an array (validate() has no union type, so the route checks
  // the shape). set_parameter_values takes [{name, value, type}] or a
  // {path: value} map; the array form was refused, so manual set tasks were
  // always empty (NET-12).
  parameters: { types: ['object', 'array'] },
  priority: { type: 'number', min: 1, max: 10 },
};

module.exports = { createCpeTask };
