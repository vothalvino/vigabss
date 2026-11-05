'use strict';

// alert_notification_channels.channel_type; any other value failed the INSERT.
const CHANNEL_TYPES = ['email', 'sms', 'whatsapp', 'telegram', 'webhook'];

const createChannel = {
  name:         { type: 'string',  required: true,  min: 1, max: 255 },
  channel_type: { type: 'string',  required: true, enum: CHANNEL_TYPES },
  is_enabled:   { type: 'boolean', required: false },
};

const updateChannel = {
  name:         { type: 'string',  required: false, min: 1, max: 255 },
  channel_type: { type: 'string',  required: false, enum: CHANNEL_TYPES },
  is_enabled:   { type: 'boolean', required: false },
};

module.exports = { createChannel, updateChannel };
