// =============================================================================
// VigaBSS 5.0 — WhatsApp bot: natural conversation and tappable replies
// =============================================================================
// With the organization's assistant on for WhatsApp, a linked customer writes
// what they need in their own words. The model only names an intent, an
// option, a date or yes/no; the bot's capabilities and their safeguards are
// the same ones the numbered menu uses. With the assistant off or failing,
// the menu bot answers exactly as before.
// =============================================================================

jest.mock('../src/services/messageOutbox', () => require('./helpers/outboxPassThrough'));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsappService');
jest.mock('../src/services/whatsappCapabilityService');
jest.mock('../src/services/whatsappUnderstanding');
jest.mock('../src/services/whatsappVoice', () => ({ transcribe: jest.fn() }));
jest.mock('../src/services/supportConversationService', () => ({
  startConversation: jest.fn(), sendMessage: jest.fn(),
}));
jest.mock('../src/utils/logger', () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => m) };
  return m;
});

const db = require('../src/config/database');
const wa = require('../src/services/whatsappService');
const cap = require('../src/services/whatsappCapabilityService');
const understanding = require('../src/services/whatsappUnderstanding');
const voice = require('../src/services/whatsappVoice');
const support = require('../src/services/supportConversationService');
const { businessToday, addDays } = require('../src/utils/businessDate');
const bot = require('../src/services/whatsappBotService');

const PHONE = '+525512345678';
const AI = { providerId: 4, masked: false };
const CONTRACTS = [
  { id: 9, planName: 'Fiber 100', label: 'Fiber 100 — Home' },
  { id: 10, planName: 'Fiber 300', label: 'Fiber 300 — Office' },
];
const say = body => bot.handleInbound({ phone: PHONE, body });
const inState = (state, context) => wa.getConversationState.mockResolvedValue({ clientId: 7, state, context });

beforeEach(() => {
  jest.resetAllMocks();
  wa.resolveBinding.mockResolvedValue({ clientId: 7, organizationId: 3, linkId: 1 });
  wa.recentInboundCount.mockResolvedValue(1);
  wa.defaultBotLocale.mockReturnValue('en');
  wa.botLocale.mockResolvedValue('en');
  wa.getConversationState.mockResolvedValue(null);
  cap.getActiveContracts.mockResolvedValue([CONTRACTS[0]]);
  cap.balanceText.mockResolvedValue('💳 Your account balance is *350.00 MXN*.');
  cap.recentWhatsappTicketCount.mockResolvedValue(0);
  cap.recentServiceRequestCount.mockResolvedValue(0);
  cap.createHumanHandoffTicket.mockResolvedValue(777);
  cap.scheduleVisit.mockResolvedValue(91);
  cap.resetWifiPassword.mockResolvedValue({ ok: true, applied: true, emailMasked: 'b***@x.com' });
  cap.maskEmail.mockReturnValue('b***@x.com');
  db.query.mockResolvedValue([[{ name: 'Ana Lopez', email: 'bob@x.com' }]]);
  understanding.availableFor.mockResolvedValue(AI);
});

describe('a message outside a flow', () => {
  it('a greeting gets a conversational greeting, not the numbered menu', async () => {
    understanding.readIntent.mockResolvedValue('greeting');
    const { reply, interactive } = await say('hola buenas tardes');
    expect(reply).toMatch(/Hi Ana! .*your own words/);
    expect(reply).not.toMatch(/1️⃣/);
    expect(interactive).toBeUndefined();
  });

  it('a short question reaches the right capability and is worded for the customer', async () => {
    understanding.readIntent.mockResolvedValue('balance');
    understanding.word.mockResolvedValue('Ana, you owe 350.00 MXN.');
    const { reply, clientId } = await say('cuánto debo');
    expect(understanding.readIntent).toHaveBeenCalledWith(3, AI, 'cuánto debo');
    expect(understanding.word).toHaveBeenCalledWith(3, 'cuánto debo', '💳 Your account balance is *350.00 MXN*.');
    expect(reply).toBe('Ana, you owe 350.00 MXN.');
    expect(clientId).toBe(7);
  });

  it('sends the rule-based answer when the rewording is refused', async () => {
    understanding.readIntent.mockResolvedValue('balance');
    understanding.word.mockResolvedValue(null);
    expect((await say('cuánto debo')).reply).toBe('💳 Your account balance is *350.00 MXN*.');
  });

  it('a described problem goes to the support engine and the answer stands alone', async () => {
    understanding.readIntent.mockResolvedValue('question');
    support.startConversation.mockResolvedValue({
      conversation: { id: 55, status: 'active' },
      messages: [{ role: 'assistant', content: 'Your line looks fine; restart the router.' }],
    });
    const { reply } = await say('se me va el internet');
    expect(support.startConversation).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp', message: 'se me va el internet' }));
    expect(reply).toBe('Your line looks fine; restart the router.');
  });

  it('asking for a person opens the hand-off ticket', async () => {
    understanding.readIntent.mockResolvedValue('human');
    expect((await say('pásame con alguien por favor')).reply).toMatch(/#777/);
    expect(cap.createHumanHandoffTicket).toHaveBeenCalledWith({ orgId: 3, clientId: 7 });
  });

  it('asks to rephrase once, then shows the menu', async () => {
    understanding.readIntent.mockResolvedValue('unclear');
    const first = await say('asdf qwer');
    expect(first.reply).toMatch(/didn't quite get that/);
    expect(wa.setConversationState).toHaveBeenCalledWith(PHONE, 7, 'chat', { misses: 1 });

    inState('chat', { misses: 1 });
    const second = await say('zzzz');
    expect(second.reply).toMatch(/1️⃣/);
    expect(second.interactive.list.rows).toHaveLength(7);
    expect(wa.clearConversationState).toHaveBeenCalledWith(PHONE);
  });

  it('a menu number still works and costs no model call', async () => {
    const { reply } = await say('1');
    expect(reply).toMatch(/350\.00/);
    expect(understanding.readIntent).not.toHaveBeenCalled();
    expect(understanding.word).not.toHaveBeenCalled();
  });

  it('falls back to the menu bot when the model cannot be reached', async () => {
    understanding.readIntent.mockResolvedValue(null);
    const { reply } = await say('hola');
    expect(reply).toMatch(/1️⃣/);
  });

  it('is the menu bot when the assistant is off', async () => {
    understanding.availableFor.mockResolvedValue(null);
    const { reply, interactive } = await say('hola');
    expect(reply).toMatch(/1️⃣/);
    expect(interactive.list.rows.map(r => r.id)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(understanding.readIntent).not.toHaveBeenCalled();
  });
});

describe('answers inside a flow', () => {
  it('picks the service the customer described', async () => {
    inState('await_visit_pick', { contracts: CONTRACTS });
    understanding.readChoice.mockResolvedValue(1);
    const { reply } = await say('el de la oficina');
    expect(understanding.readChoice).toHaveBeenCalledWith(3, AI, 'el de la oficina', ['Fiber 100 — Home', 'Fiber 300 — Office']);
    expect(wa.setConversationState).toHaveBeenCalledWith(PHONE, 7, 'await_visit_date', { contract: CONTRACTS[1] });
    expect(reply).toMatch(/Which day would you like/);
  });

  it('a number still picks without a model call', async () => {
    inState('await_visit_pick', { contracts: CONTRACTS });
    await say('2');
    expect(understanding.readChoice).not.toHaveBeenCalled();
    expect(wa.setConversationState).toHaveBeenCalledWith(PHONE, 7, 'await_visit_date', { contract: CONTRACTS[1] });
  });

  it('offers the options again when the choice is not clear', async () => {
    inState('await_contract_pick', { contracts: CONTRACTS });
    understanding.readChoice.mockResolvedValue(null);
    const { interactive } = await say('no sé');
    expect(interactive.list.rows).toEqual([
      { id: '1', title: '1. Fiber 100', description: 'Fiber 100 — Home' },
      { id: '2', title: '2. Fiber 300', description: 'Fiber 300 — Office' },
    ]);
    expect(wa.setConversationState).not.toHaveBeenCalled();
  });

  it('books a visit from "tomorrow afternoon" in one message', async () => {
    const tomorrow = addDays(businessToday(), 1);
    inState('await_visit_date', { contract: CONTRACTS[0] });
    understanding.readVisit.mockResolvedValue({ date: tomorrow, slot: 'afternoon' });
    const { reply } = await say('mañana en la tarde');
    expect(cap.scheduleVisit).toHaveBeenCalledWith({ orgId: 3, clientId: 7, contract: CONTRACTS[0], preferredDate: tomorrow, slot: 'afternoon' });
    expect(reply).toMatch(/#91/);
  });

  it('asks for the time when only the day was given, with buttons', async () => {
    const tomorrow = addDays(businessToday(), 1);
    inState('await_visit_date', { contract: CONTRACTS[0] });
    understanding.readVisit.mockResolvedValue({ date: tomorrow, slot: null });
    const { interactive } = await say('mañana');
    expect(wa.setConversationState).toHaveBeenCalledWith(PHONE, 7, 'await_visit_slot', { contract: CONTRACTS[0], date: tomorrow });
    expect(interactive.buttons.map(b => b.id)).toEqual(['morning', 'afternoon', 'evening']);
    expect(cap.scheduleVisit).not.toHaveBeenCalled();
  });

  it('never books a date in the past, whatever the model returns', async () => {
    inState('await_visit_date', { contract: CONTRACTS[0] });
    understanding.readVisit.mockResolvedValue({ date: '2020-01-01', slot: 'morning' });
    const { reply, interactive } = await say('el primero de enero');
    expect(cap.scheduleVisit).not.toHaveBeenCalled();
    expect(reply).toMatch(/couldn't work out the day/);
    expect(interactive.buttons.map(b => b.id)).toEqual([addDays(businessToday(), 1), addDays(businessToday(), 2)]);
  });

  it('a tapped date button is a date', async () => {
    const dayAfter = addDays(businessToday(), 2);
    inState('await_visit_date', { contract: CONTRACTS[0] });
    await say(dayAfter);
    expect(understanding.readVisit).not.toHaveBeenCalled();
    expect(wa.setConversationState).toHaveBeenCalledWith(PHONE, 7, 'await_visit_slot', { contract: CONTRACTS[0], date: dayAfter });
  });

  it('resets the Wi-Fi password on a clear yes in the customer\'s words', async () => {
    inState('await_wifi_confirm', { contract: CONTRACTS[0], emailMasked: 'b***@x.com' });
    understanding.readConfirm.mockResolvedValue('yes');
    const { reply } = await say('sí, hazlo por favor');
    expect(cap.resetWifiPassword).toHaveBeenCalledWith({ orgId: 3, clientId: 7, contract: CONTRACTS[0] });
    expect(reply).toMatch(/b\*\*\*@x\.com/);
  });

  it('does not reset it when the answer is not a clear yes', async () => {
    inState('await_wifi_confirm', { contract: CONTRACTS[0], emailMasked: 'b***@x.com' });
    understanding.readConfirm.mockResolvedValue(null);
    const { interactive } = await say('¿y se desconecta mi tele?');
    expect(cap.resetWifiPassword).not.toHaveBeenCalled();
    expect(interactive.buttons.map(b => b.id)).toEqual(['confirm', 'cancel']);
  });

  it('cancels on a no', async () => {
    inState('await_wifi_confirm', { contract: CONTRACTS[0], emailMasked: 'b***@x.com' });
    understanding.readConfirm.mockResolvedValue('no');
    const { reply } = await say('mejor no, gracias');
    expect(cap.resetWifiPassword).not.toHaveBeenCalled();
    expect(wa.clearConversationState).toHaveBeenCalledWith(PHONE);
    expect(reply).toMatch(/cancelled/);
  });

  it('the confirm button confirms without a model call', async () => {
    inState('await_wifi_confirm', { contract: CONTRACTS[0], emailMasked: 'b***@x.com' });
    await say('confirm');
    expect(understanding.readConfirm).not.toHaveBeenCalled();
    expect(cap.resetWifiPassword).toHaveBeenCalled();
  });

  it('with the assistant off, a free answer does not confirm anything', async () => {
    understanding.availableFor.mockResolvedValue(null);
    inState('await_wifi_confirm', { contract: CONTRACTS[0], emailMasked: 'b***@x.com' });
    const { reply } = await say('sí, hazlo por favor');
    expect(cap.resetWifiPassword).not.toHaveBeenCalled();
    expect(reply).toMatch(/CONFIRM/);
  });
});

describe('tappable replies', () => {
  beforeEach(() => { understanding.availableFor.mockResolvedValue(null); });

  it('the Wi-Fi confirmation carries Yes and Cancel buttons and stays complete as text', async () => {
    const { reply, interactive } = await say('5');
    expect(reply).toMatch(/CONFIRM/);
    expect(interactive.body).toMatch(/b\*\*\*@x\.com/);
    expect(interactive.buttons).toEqual([{ id: 'confirm', title: 'Yes, change it' }, { id: 'cancel', title: 'Cancel' }]);
  });

  it('more than ten services has no list: the numbered text is the reply', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, planName: `Plan ${i + 1}`, label: `Plan ${i + 1} — Site ${i + 1}` }));
    cap.getActiveContracts.mockResolvedValue(many);
    const { reply, interactive } = await say('6');
    expect(interactive).toBeNull();
    expect(reply).toMatch(/11\) Plan 11/);
  });
});

describe('voice notes', () => {
  const AUDIO = { id: 'media123', mimeType: 'audio/ogg; codecs=opus' };
  const note = () => bot.handleInbound({ phone: PHONE, body: '', audio: AUDIO, provider: 'meta' });

  it('is answered like the same words typed, and the transcript is returned for the record', async () => {
    voice.transcribe.mockResolvedValue('cuánto debo');
    understanding.readIntent.mockResolvedValue('balance');
    understanding.word.mockResolvedValue('Ana, you owe 350.00 MXN.');
    const result = await note();
    expect(voice.transcribe).toHaveBeenCalledWith({ orgId: 3, provider: 'meta', audio: AUDIO, locale: 'en' });
    expect(understanding.readIntent).toHaveBeenCalledWith(3, AI, 'cuánto debo');
    expect(result).toMatchObject({ reply: 'Ana, you owe 350.00 MXN.', clientId: 7, transcript: 'cuánto debo' });
  });

  it('works as the answer inside a flow', async () => {
    inState('await_wifi_confirm', { contract: CONTRACTS[0], emailMasked: 'b***@x.com' });
    voice.transcribe.mockResolvedValue('sí, hazlo');
    understanding.readConfirm.mockResolvedValue('yes');
    await note();
    expect(cap.resetWifiPassword).toHaveBeenCalled();
  });

  it('asks the customer to type when the note cannot be transcribed', async () => {
    voice.transcribe.mockResolvedValue(null);
    const result = await note();
    expect(result.reply).toMatch(/couldn't listen to your voice message/);
    expect(result.transcript).toBeUndefined();
    expect(understanding.readIntent).not.toHaveBeenCalled();
  });

  it('is not transcribed for a flooding sender', async () => {
    wa.recentInboundCount.mockResolvedValue(1000);
    const result = await note();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/wait a few minutes/i);
  });

  it('is not transcribed for a number that is not linked', async () => {
    wa.resolveBinding.mockResolvedValue(null);
    wa.verifyPhoneCode.mockResolvedValue({ ok: false, reason: 'no_pending' });
    wa.verifyPortalCode.mockResolvedValue({ ok: false, reason: 'no_match' });
    const result = await note();
    expect(voice.transcribe).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/connect you to your ISP account/i);
  });
});
