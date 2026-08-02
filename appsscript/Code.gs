/**
 * Mint Voicemail — Gmail notifier (Google Apps Script)
 *
 * Runs under YOUR Google account, so notification emails are sent from your own
 * Gmail address. They thread by caller, land under a "Voicemail" label, and no
 * third-party email service ever sees your transcripts.
 *
 * Deploy: Deploy > New deployment > Web app
 *   Execute as:      Me
 *   Who has access:  Anyone
 *
 * "Anyone" is required because Cloudflare calls this anonymously — the shared
 * secret below is what actually authenticates the caller. Treat the deployment
 * URL as a secret too.
 *
 * Then run setup() once from the editor to generate the secret and grant the
 * Gmail permission.
 */

var PROP = PropertiesService.getScriptProperties();
var LABEL_NAME = 'Voicemail';

/**
 * Run this once from the Apps Script editor.
 * Prints the shared secret to paste into the Worker as GAS_SHARED_SECRET.
 */
function setup() {
  var secret = PROP.getProperty('SHARED_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    PROP.setProperty('SHARED_SECRET', secret);
  }
  getOrCreateLabel();

  Logger.log('=========================================');
  Logger.log('GAS_SHARED_SECRET:');
  Logger.log(secret);
  Logger.log('');
  Logger.log('Notifications will be sent to: ' + Session.getEffectiveUser().getEmail());
  Logger.log('=========================================');
  return secret;
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // Constant-time-ish comparison of the shared secret.
    var expected = PROP.getProperty('SHARED_SECRET');
    if (!expected || !safeEquals(String(body.secret || ''), expected)) {
      return jsonOut({ error: 'unauthorized' });
    }

    if (body.kind === 'voicemail') return jsonOut(sendVoicemailEmail(body));
    if (body.kind === 'magic')     return jsonOut(sendMagicLinkEmail(body));
    if (body.kind === 'test')      return jsonOut(sendTestEmail());

    return jsonOut({ error: 'unknown kind' });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

/** Health check so you can confirm the deployment URL in a browser. */
function doGet() {
  return jsonOut({ ok: true, service: 'mint-voicemail-gmail' });
}

/* ------------------------------------------------------------------ */
/* Emails                                                              */
/* ------------------------------------------------------------------ */

function sendVoicemailEmail(body) {
  var to = Session.getEffectiveUser().getEmail();
  var label = body.fromLabel || body.from || 'Unknown caller';
  var subject = 'Voicemail from ' + label;

  var transcript = body.transcript
    ? body.transcript
    : 'Transcript not available yet — open the app to listen.';

  var plain = [
    label + ' left you a ' + formatDuration(body.duration) + ' voicemail.',
    '',
    transcript,
    '',
    'Listen or manage: ' + body.appUrl,
  ].join('\n');

  var html = buildHtml(label, body, transcript);

  GmailApp.sendEmail(to, subject, plain, {
    htmlBody: html,
    name: 'Voicemail',
    // Replying to a voicemail notification should go to nobody, not to yourself.
    noReply: false,
  });

  applyLabelToLatest(subject);
  return { ok: true, sentTo: to };
}

function sendMagicLinkEmail(body) {
  var to = Session.getEffectiveUser().getEmail();

  var plain = [
    'Here is your sign-in link for Mint Voicemail:',
    '',
    body.link,
    '',
    'It expires in ' + (body.expiresInMinutes || 15) + ' minutes and can be used once.',
    '',
    'Requested from IP ' + (body.ip || 'unknown'),
    'Device: ' + (body.userAgent || 'unknown'),
    '',
    "If you didn't request this, ignore this email — the link is useless without",
    'this inbox, and nobody else can trigger one.',
  ].join('\n');

  var html =
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:480px">' +
      '<h2 style="margin:0 0 16px">Sign in to Voicemail</h2>' +
      '<p style="margin:0 0 24px;color:#444">Tap the button below. It expires in ' +
        (body.expiresInMinutes || 15) + ' minutes and works once.</p>' +
      '<a href="' + escapeHtml(body.link) + '" ' +
        'style="display:inline-block;background:#16a34a;color:#fff;padding:12px 24px;' +
        'border-radius:8px;text-decoration:none;font-weight:600">Sign in</a>' +
      '<p style="margin:24px 0 0;font-size:12px;color:#888">' +
        'Requested from ' + escapeHtml(body.ip || 'unknown') + '<br>' +
        escapeHtml((body.userAgent || 'unknown').substring(0, 120)) + '</p>' +
      '<p style="margin:16px 0 0;font-size:12px;color:#888">' +
        "If this wasn't you, you can ignore it safely.</p>" +
    '</div>';

  GmailApp.sendEmail(to, 'Your Voicemail sign-in link', plain, {
    htmlBody: html,
    name: 'Voicemail',
  });

  return { ok: true, sentTo: to };
}

function sendTestEmail() {
  var to = Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(to, 'Voicemail notifications are working',
    'If you are reading this, the Worker can reach Apps Script and send mail as you.',
    { name: 'Voicemail' });
  return { ok: true, sentTo: to };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function buildHtml(label, body, transcript) {
  return '' +
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px">' +
      '<div style="border-left:3px solid #16a34a;padding-left:16px;margin-bottom:20px">' +
        '<div style="font-size:18px;font-weight:600">' + escapeHtml(label) + '</div>' +
        '<div style="color:#666;font-size:13px">' +
          formatDuration(body.duration) + ' &middot; ' + new Date().toLocaleString() +
        '</div>' +
      '</div>' +
      '<div style="background:#f6f8f6;border-radius:10px;padding:16px;line-height:1.6;' +
        'font-size:15px;white-space:pre-wrap">' + escapeHtml(transcript) + '</div>' +
      '<a href="' + escapeHtml(body.appUrl || '#') + '" ' +
        'style="display:inline-block;margin-top:20px;background:#16a34a;color:#fff;' +
        'padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600">' +
        'Listen &amp; manage</a>' +
    '</div>';
}

function getOrCreateLabel() {
  var label = GmailApp.getUserLabelByName(LABEL_NAME);
  return label || GmailApp.createLabel(LABEL_NAME);
}

/**
 * Gmail has no "label on send", so tag the just-sent thread. Best effort:
 * a failure here must never break the notification itself.
 */
function applyLabelToLatest(subject) {
  try {
    var threads = GmailApp.search('subject:"' + subject.replace(/"/g, '') + '" newer_than:1d', 0, 1);
    if (threads.length) getOrCreateLabel().addToThread(threads[0]);
  } catch (err) {
    Logger.log('label failed: ' + err);
  }
}

function formatDuration(seconds) {
  var s = parseInt(seconds, 10) || 0;
  if (s < 60) return s + ' second' + (s === 1 ? '' : 's');
  var m = Math.floor(s / 60);
  var r = s % 60;
  return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
}

function safeEquals(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
